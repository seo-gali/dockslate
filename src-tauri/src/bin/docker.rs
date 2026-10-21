#[path = "../cli_platform.rs"]
mod cli_platform;

use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("DockSlate CLI: {message}");
            std::process::exit(125);
        }
    }
}

fn plain_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x00200000);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Docker component files cannot be reparse points.".into());
        }
    }
    if !metadata.is_file() || metadata.len() > 128 * 1024 * 1024 {
        return Err("A bundled Docker component is missing or excessive.".into());
    }
    Ok(file)
}

fn profile() -> Result<(PathBuf, Vec<File>), String> {
    let local = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .ok_or("The current-user application data directory is unavailable.")?;
    let directory = PathBuf::from(local).join("DockSlate/cli");
    if !directory.is_absolute() {
        return Err("The Docker CLI profile must be an absolute local path.".into());
    }
    let plugins = directory.join("cli-plugins");
    let ancestors: Vec<&Path> = plugins.ancestors().collect();
    let mut guards = Vec::new();
    for parent in ancestors.into_iter().rev() {
        if !parent.try_exists().map_err(|error| error.to_string())? {
            match fs::create_dir(parent) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
                Err(error) => return Err(error.to_string()),
            }
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options
                .access_mode(0x80)
                .share_mode(3)
                .custom_flags(0x02000000 | 0x00200000);
        }
        let guard = options.open(parent).map_err(|error| error.to_string())?;
        let metadata = guard.metadata().map_err(|error| error.to_string())?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("The Docker CLI profile cannot contain reparse points.".into());
            }
        }
        if !metadata.is_dir() {
            return Err("The Docker CLI profile is not a directory.".into());
        }
        guards.push(guard);
    }
    Ok((directory, guards))
}

fn compare_plugin(mut input: File, target: &Path) -> Result<(), String> {
    let mut installed = plain_file(target)?;
    if installed.metadata().map_err(|e| e.to_string())?.len()
        != input.metadata().map_err(|e| e.to_string())?.len()
    {
        return Err(format!(
            "A different Docker plugin already exists at {}. It was preserved.",
            target.display()
        ));
    }
    let mut expected = [0u8; 32768];
    let mut actual = [0u8; 32768];
    loop {
        let count = input.read(&mut expected).map_err(|e| e.to_string())?;
        if count == 0 {
            return Ok(());
        }
        installed
            .read_exact(&mut actual[..count])
            .map_err(|e| e.to_string())?;
        if expected[..count] != actual[..count] {
            return Err(format!(
                "A different Docker plugin already exists at {}. It was preserved.",
                target.display()
            ));
        }
    }
}

#[cfg(windows)]
fn publish(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileW(source: *const u16, target: *const u16) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileW(source.as_ptr(), target.as_ptr()) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn publish(source: &Path, target: &Path) -> io::Result<()> {
    fs::hard_link(source, target)?;
    fs::remove_file(source)
}

struct PartialPlugin(PathBuf);
impl Drop for PartialPlugin {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn install_plugin(source: &Path, target: &Path) -> Result<(), String> {
    let mut input = plain_file(source)?;
    if target.try_exists().map_err(|error| error.to_string())? {
        return compare_plugin(input, target);
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let temporary = PartialPlugin(target.with_file_name(format!(
        ".dockslate-plugin-{}-{nonce}.tmp",
        std::process::id()
    )));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary.0)
        .map_err(|error| error.to_string())?;
    std::io::copy(&mut input, &mut output)
        .and_then(|_| output.flush())
        .and_then(|_| output.sync_all())
        .map_err(|error| format!("The Docker plugin could not be prepared: {error}"))?;
    drop(output);
    match publish(&temporary.0, target) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(error.raw_os_error(), Some(80 | 183))
                || error.kind() == io::ErrorKind::AlreadyExists =>
        {
            compare_plugin(plain_file(source)?, target)
        }
        Err(error) => Err(format!("The Docker plugin could not be published: {error}")),
    }
}

fn local_command(arguments: &[OsString]) -> bool {
    let mut index = 0;
    while let Some(value) = arguments.get(index).and_then(|a| a.to_str()) {
        match value {
            "--help" | "-h" | "--version" | "-v" | "help" => return true,
            "--debug" | "-D" => index += 1,
            "--log-level" | "-l" => index += 2,
            value if value.starts_with("--log-level=") => index += 1,
            "compose" | "buildx" => {
                return matches!(
                    arguments.get(index + 1).and_then(|a| a.to_str()),
                    Some("version" | "--version" | "--help" | "-h")
                )
            }
            _ => return false,
        }
    }
    true
}

fn run() -> Result<i32, String> {
    let launcher = std::env::current_exe().map_err(|error| error.to_string())?;
    let parent = launcher
        .parent()
        .ok_or("The Docker launcher directory is unavailable.")?;
    let root = if parent
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
    {
        parent
            .parent()
            .ok_or("The DockSlate installation directory is unavailable.")?
    } else {
        parent
    };
    let native = root.join("libexec/docker.exe");
    drop(plain_file(&native)?);
    let (config, _profile_guards) = profile()?;
    for name in ["docker-compose.exe", "docker-buildx.exe"] {
        install_plugin(
            &root.join("libexec/cli-plugins").join(name),
            &config.join("cli-plugins").join(name),
        )?;
    }
    let arguments: Vec<OsString> = std::env::args_os().skip(1).collect();
    if !local_command(&arguments) {
        cli_platform::ensure_proxy(&root.join("dockslate.exe"))?;
    }
    let mut command = Command::new(&native);
    command
        .arg("--config")
        .arg(&config)
        .args(&arguments)
        .env("DOCKER_HOST", cli_platform::endpoint()?)
        .env_remove("DOCKER_CONTEXT")
        .env_remove("DOCKER_TLS")
        .env_remove("DOCKER_TLS_VERIFY")
        .env_remove("DOCKER_CERT_PATH")
        .env_remove("DOCKER_CONFIG")
        .env_remove("BUILDX_BUILDER")
        .env_remove("BUILDX_CONFIG")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let status = command
        .status()
        .map_err(|error| format!("The official Windows Docker CLI could not run: {error}"))?;
    Ok(status.code().unwrap_or(125))
}
