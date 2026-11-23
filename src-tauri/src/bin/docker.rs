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
fn publish(source: &Path, target: &Path, replace: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), u32::from(replace)) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn publish(source: &Path, target: &Path, replace: bool) -> io::Result<()> {
    if replace { return fs::rename(source, target); }
    fs::hard_link(source, target)?;
    fs::remove_file(source)
}

#[cfg(windows)]
fn sha256(bytes: &[u8]) -> Result<String, String> {
    use std::ffi::c_void;
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptHash(algorithm: *mut c_void, secret: *const u8, secret_size: u32, input: *const u8, input_size: u32, output: *mut u8, output_size: u32) -> i32;
    }
    let length = u32::try_from(bytes.len()).map_err(|_| "Plugin exceeds hash input limit")?;
    let mut digest = [0u8;32];
    // Windows SHA-256 pseudo-handle, available since Windows 10.
    if unsafe { BCryptHash(0x41usize as *mut c_void, std::ptr::null(), 0, bytes.as_ptr(), length, digest.as_mut_ptr(), 32) } < 0 {
        return Err("Cannot verify the previous Docker plugin".into());
    }
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn previous_plugin(target: &Path) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let expected = match target.file_name().and_then(|name| name.to_str()) {
            Some("docker-compose.exe") => "8aeaa0055e660e12cf07cd70680dc8333957fe6718528b91ec3da084eab62483",
            Some("docker-buildx.exe") => "b39784aed5b3f9b24d1971bbcbad8c8206033fa63ed4fea82c9141728fe0ea26",
            _ => return Ok(false),
        };
        let mut bytes = Vec::new();
        plain_file(target)?.read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        Ok(sha256(&bytes)? == expected)
    }
    #[cfg(not(windows))]
    { let _ = target; Ok(false) }
}

struct PartialPlugin(PathBuf);
impl Drop for PartialPlugin {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn install_plugin(source: &Path, target: &Path) -> Result<(), String> {
    let mut input = plain_file(source)?;
    let replace = if target.try_exists().map_err(|error| error.to_string())? {
        match compare_plugin(plain_file(source)?, target) {
            Ok(()) => return Ok(()),
            Err(error) if !previous_plugin(target)? => return Err(error),
            Err(_) => true,
        }
    } else { false };
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
    if replace && !previous_plugin(target)? { return Err("The Docker plugin changed during update. It was preserved.".into()); }
    match publish(&temporary.0, target, replace) {
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

#[cfg(all(test, windows))]
mod security_tests {
    #[test]
    fn plugin_hash_matches_standard_sha256_vector() {
        assert_eq!(super::sha256(b"abc").unwrap(),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn desktop_source_query_does_not_prepare_the_owned_engine() {
        let args = ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine", "info", "--format", "{{json .}}"].map(std::ffi::OsString::from);
        assert!(super::local_command(&args), "Desktop source queries must not start or wait for the DockSlate proxy");
        let owned = ["--host", "npipe:////./pipe/dockslate_engine_test", "info"].map(std::ffi::OsString::from);
        assert!(!super::local_command(&owned));
        let misplaced = ["info", "--host", "npipe:////./pipe/dockerDesktopLinuxEngine"].map(std::ffi::OsString::from);
        assert!(!super::local_command(&misplaced));
        let plugin = ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine", "compose", "version"].map(std::ffi::OsString::from);
        assert!(!super::desktop_source_command(&plugin));
    }
}

fn desktop_source_command(arguments: &[OsString]) -> bool {
    arguments.first().is_some_and(|value| value == "--host")
        && arguments.get(1).is_some_and(|value| value == cli_platform::DESKTOP_SOURCE)
        && arguments.get(2).and_then(|value| value.to_str()).is_some_and(|value| ["info", "container", "image", "volume", "network"].contains(&value))
}

fn local_command(arguments: &[OsString]) -> bool {
    if desktop_source_command(arguments) { return true; }
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
    let arguments: Vec<OsString> = std::env::args_os().skip(1).collect();
    // Desktop migration uses core commands and never needs the owned proxy or plugins.
    if !desktop_source_command(&arguments) {
        for name in ["docker-compose.exe", "docker-buildx.exe"] {
            install_plugin(
                &root.join("libexec/cli-plugins").join(name),
                &config.join("cli-plugins").join(name),
            )?;
        }
    }
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
        .env_remove("DOCKER_API_VERSION")
        .env_remove("DOCKER_CUSTOM_HEADERS")
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
