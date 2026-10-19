use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::OsString,
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const RUNTIME_CONTROL: &str = include_str!("../../scripts/runtime-control.ps1");
const SOCKET: &str = "unix:///var/run/docker.sock";
const LIMIT: usize = 262_144;

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("DockSlate CLI: {message}");
            std::process::exit(125);
        }
    }
}

#[cfg(windows)]
fn system_directory() -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = vec![0u16; 32768];
    let count = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if count == 0 || count as usize >= buffer.len() {
        return Err("Windows system directory is unavailable.".into());
    }
    Ok(PathBuf::from(OsString::from_wide(
        &buffer[..count as usize],
    )))
}

#[cfg(not(windows))]
fn system_directory() -> Result<PathBuf, String> {
    Err("This launcher requires Windows 11 and DockSlate's owned WSL engine.".into())
}

fn drain(mut stream: impl Read + Send + 'static) -> thread::JoinHandle<Result<Vec<u8>, String>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 8192];
        let mut excessive = false;
        loop {
            let count = stream
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            let remaining = LIMIT.saturating_sub(bytes.len());
            bytes.extend_from_slice(&buffer[..count.min(remaining)]);
            excessive |= count > remaining;
        }
        if excessive {
            Err("Engine verification output exceeded its limit.".into())
        } else {
            Ok(bytes)
        }
    })
}

fn capture(mut command: Command, input: Option<&str>) -> Result<Vec<u8>, String> {
    command.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let out = drain(
        child
            .stdout
            .take()
            .ok_or("Verification output is unavailable.")?,
    );
    let err = drain(
        child
            .stderr
            .take()
            .ok_or("Verification errors are unavailable.")?,
    );
    if let Some(input) = input {
        let result = child
            .stdin
            .take()
            .ok_or("Verification input is unavailable.")?
            .write_all(input.as_bytes());
        if let Err(error) = result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
    }
    let deadline = Instant::now() + Duration::from_secs(35);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Read-only engine verification timed out. No engine was installed or started."
                    .into(),
            );
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = out
        .join()
        .map_err(|_| "Verification output thread failed.")??;
    let stderr = err
        .join()
        .map_err(|_| "Verification error thread failed.")??;
    if !status.success() {
        return Err(format!(
            "Engine verification failed ({}): {}",
            status.code().unwrap_or(125),
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    Ok(stdout)
}

fn runtime_status(system: &Path) -> Result<Value, String> {
    let program = system.join("WindowsPowerShell/v1.0/powershell.exe");
    let mut command = Command::new(&program);
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "& ([scriptblock]::Create([Console]::In.ReadToEnd()))",
    ]);
    command.env(
        "DOCKSLATE_RUNTIME_REQUEST",
        json!({"mode":"status"}).to_string(),
    );
    command.env_remove("DOCKSLATE_RUNTIME_SETUP");
    command.env(
        "PSModulePath",
        program
            .parent()
            .ok_or("PowerShell directory is unavailable.")?
            .join("Modules"),
    );
    let script =
        format!("[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n{RUNTIME_CONTROL}");
    let output = capture(command, Some(&script))?;
    let status: Value = serde_json::from_slice(&output)
        .map_err(|_| "DockSlate ownership verification returned invalid JSON.")?;
    if status["state"] != "running"
        || status["keeperVerified"] != true
        || status["distribution"] != "DockSlate"
    {
        return Err(format!(
            "{} Open DockSlate and complete Docker Engine setup/start first.",
            status["message"]
                .as_str()
                .unwrap_or("The owned engine is unavailable.")
        ));
    }
    Ok(status)
}

#[cfg(windows)]
fn pin(path: &Path, directory: bool) -> Result<File, String> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    for part in path.ancestors() {
        let metadata = std::fs::symlink_metadata(part).map_err(|error| error.to_string())?;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Runtime ownership paths cannot be reparse points.".into());
        }
    }
    let mut options = OpenOptions::new();
    options.read(true).share_mode(if directory { 3 } else { 1 });
    options.custom_flags(0x00200000 | if directory { 0x02000000 } else { 0 });
    options.open(path).map_err(|_| "The engine is changing or held by another DockSlate operation. Retry after it completes.".into())
}

#[cfg(not(windows))]
fn pin(_path: &Path, _directory: bool) -> Result<File, String> {
    Err("Windows runtime ownership handles are unavailable.".into())
}

fn pinned_json(file: &mut File) -> Result<Value, String> {
    let mut bytes = Vec::new();
    file.take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > LIMIT {
        return Err("Runtime ownership metadata is excessive.".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Runtime ownership metadata is invalid.".into())
}

fn acquire_runtime(status: &Value) -> Result<Vec<File>, String> {
    let owner = PathBuf::from(
        status["installPath"]
            .as_str()
            .ok_or("Runtime path is unavailable.")?,
    );
    let root = owner.parent().ok_or("Runtime parent is unavailable.")?;
    let lock = pin(&root.join("mutation.lock"), false)?;
    let mut marker = pin(&root.join("ownership.json"), false)?;
    let mut keeper = pin(&root.join("keeper.json"), false)?;
    let metadata = pinned_json(&mut marker)?;
    let keeper_metadata = pinned_json(&mut keeper)?;
    if metadata["owner"] != "DockSlate"
        || metadata["state"] != "installed"
        || metadata["schema"] != 1
        || metadata["distribution"] != "DockSlate"
        || keeper_metadata["distribution"] != "DockSlate"
        || keeper_metadata["installId"] != metadata["installId"]
    {
        return Err("Runtime ownership changed. No Docker command was forwarded.".into());
    }
    for key in [
        "installPath",
        "registrationId",
        "installId",
        "engineVersion",
        "rootfsSha256",
    ] {
        if metadata[key].as_str().is_none() || metadata[key] != status["fingerprint"][key] {
            return Err("Runtime ownership changed. No Docker command was forwarded.".into());
        }
    }
    Ok(vec![
        lock,
        marker,
        keeper,
        pin(root, true)?,
        pin(&owner, true)?,
    ])
}

fn guest(system: &Path) -> Command {
    let mut command = Command::new(system.join("wsl.exe"));
    command.args(["--distribution", "DockSlate", "--user", "root"]);
    for (name, _) in std::env::vars_os() {
        let upper = name.to_string_lossy().to_ascii_uppercase();
        if upper.starts_with("DOCKER_") || upper.starts_with("BUILDX_") || upper == "BUILDKIT_HOST"
        {
            command.env_remove(name);
        }
    }
    command
}

fn docker_command(system: &Path, cwd: Option<&str>) -> Command {
    let mut command = guest(system);
    if let Some(cwd) = cwd {
        command.args(["--cd", cwd]);
    }
    command.args([
        "--exec",
        "/usr/bin/env",
        "-u",
        "DOCKER_HOST",
        "-u",
        "DOCKER_CONTEXT",
        "-u",
        "DOCKER_TLS_VERIFY",
        "-u",
        "DOCKER_CERT_PATH",
        "-u",
        "DOCKER_API_VERSION",
        "-u",
        "DOCKER_CONFIG",
        "-u",
        "BUILDX_BUILDER",
        "-u",
        "BUILDX_CONFIG",
        "-u",
        "BUILDKIT_HOST",
        "BUILDX_BUILDER=default",
        "/usr/bin/docker",
        "--host",
        SOCKET,
    ]);
    command
}

fn verify_engine(system: &Path) -> Result<(), String> {
    let mut version = docker_command(system, None);
    version.args(["version", "--format", "{{json .Server}}"]);
    let version: Value = serde_json::from_slice(&capture(version, None)?)
        .map_err(|_| "Invalid Docker Engine version response.")?;
    if version["Os"] != "linux"
        || !version["Components"]
            .as_array()
            .is_some_and(|parts| parts.iter().any(|part| part["Name"] == "Engine"))
    {
        return Err("The owned socket does not expose Linux Docker Engine.".into());
    }
    let api = version["ApiVersion"]
        .as_str()
        .and_then(|value| value.strip_prefix("1."))
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or("Docker API version is unavailable.")?;
    if api < 41 {
        return Err("Docker API 1.41 or later is required.".into());
    }
    let mut info = docker_command(system, None);
    info.args(["info", "--format", "{{json .}}"]);
    let info: Value = serde_json::from_slice(&capture(info, None)?)
        .map_err(|_| "Invalid Docker Engine identity response.")?;
    if info["OSType"] != "linux"
        || info["ID"].as_str().is_none_or(str::is_empty)
        || info["OperatingSystem"]
            .as_str()
            .is_some_and(|value| value.to_ascii_lowercase().contains("docker desktop"))
    {
        return Err("The owned Docker Engine identity could not be verified.".into());
    }
    Ok(())
}

struct Paths<'a> {
    system: &'a Path,
    cwd: PathBuf,
    cache: HashMap<String, String>,
}

fn drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

impl Paths<'_> {
    fn map(&mut self, value: &str) -> Result<String, String> {
        if value == "-" || value.starts_with('/') && !value.starts_with("//") {
            return Ok(value.into());
        }
        if value.chars().any(char::is_control)
            || value.starts_with("\\\\")
            || value.starts_with("//")
            || value.len() >= 2 && value.as_bytes()[1] == b':' && !drive_path(value)
        {
            return Err(format!("Unsupported Windows path: {value}. Use an absolute local drive path or a path relative to the current folder."));
        }
        let path = if drive_path(value) {
            PathBuf::from(value)
        } else {
            self.cwd.join(value)
        };
        let value = path
            .to_str()
            .ok_or("Windows paths must contain valid Unicode.")?
            .to_owned();
        if !drive_path(&value) {
            return Err("The Windows current folder must be on a local drive.".into());
        }
        if let Some(mapped) = self.cache.get(&value) {
            return Ok(mapped.clone());
        }
        let mut command = guest(self.system);
        command.args(["--exec", "/usr/bin/wslpath", "-a", "-u", &value]);
        let output = capture(command, None)?;
        let mapped = String::from_utf8(output)
            .map_err(|_| "WSL path conversion returned invalid UTF-8.")?
            .trim_end_matches(['\r', '\n'])
            .to_owned();
        if !mapped.starts_with('/') || mapped.chars().any(char::is_control) {
            return Err("WSL path conversion returned an invalid absolute path.".into());
        }
        self.cache.insert(value, mapped.clone());
        Ok(mapped)
    }

    fn volume(&mut self, value: &str) -> Result<String, String> {
        let skip = if drive_path(value) { 2 } else { 0 };
        let Some(split) = value[skip..].find(':').map(|index| index + skip) else {
            return Ok(value.into());
        };
        let source = &value[..split];
        if drive_path(source)
            || source.starts_with('.')
            || source.contains('\\')
            || source.contains('/') && !source.starts_with('/')
        {
            Ok(format!("{}{}", self.map(source)?, &value[split..]))
        } else {
            Ok(value.into())
        }
    }

    fn mount(&mut self, value: &str) -> Result<String, String> {
        if value.contains('"') {
            return Err("Quoted CSV --mount fields are unsupported by this launcher. Use -v for Windows paths containing commas.".into());
        }
        let mut fields: Vec<String> = value.split(',').map(String::from).collect();
        if fields.iter().any(|field| field == "type=bind") {
            for field in &mut fields {
                if let Some((key, source)) = field.split_once('=') {
                    if matches!(key, "source" | "src") {
                        let mapped = self.map(source)?;
                        if mapped.contains(',') {
                            return Err(
                                "A comma in a bind source requires -v instead of --mount.".into()
                            );
                        }
                        *field = format!("{key}={mapped}");
                    }
                }
            }
        }
        Ok(fields.join(","))
    }

    fn fields(&mut self, value: &str, kind: &str) -> Result<String, String> {
        if kind == "output" && !value.contains('=') {
            return self.map(value);
        }
        if value.contains('"') {
            return Err("Quoted CSV build fields are unsupported by this launcher.".into());
        }
        let mut fields: Vec<String> = value.split(',').map(String::from).collect();
        let local_cache = fields.iter().any(|field| field == "type=local");
        for field in &mut fields {
            if let Some((key, source)) = field.split_once('=') {
                let map = match kind {
                    "secret" => matches!(key, "src" | "source"),
                    "output" => matches!(key, "dest" | "destination"),
                    "cache" => local_cache && matches!(key, "src" | "dest"),
                    "context" => !source.contains("://") && !source.starts_with("git@"),
                    _ => false,
                };
                if map {
                    let mapped = self.map(source)?;
                    if mapped.contains(',') {
                        return Err(
                            "Commas in CSV build paths are unsupported by this launcher.".into(),
                        );
                    }
                    *field = format!("{key}={mapped}");
                }
            }
        }
        Ok(fields.join(","))
    }
}

fn take_value(
    arguments: &mut [String],
    index: &mut usize,
    paths: &mut Paths<'_>,
    kind: &str,
) -> Result<(), String> {
    let position = *index;
    let (flag, value, inline) = if let Some((flag, value)) = arguments[position]
        .split_once('=')
        .filter(|(flag, _)| flag.starts_with("--"))
    {
        (flag.to_owned(), value.to_owned(), true)
    } else if arguments[position].starts_with('-')
        && !arguments[position].starts_with("--")
        && arguments[position].len() > 2
        && arguments[position].is_char_boundary(2)
    {
        (
            arguments[position][..2].into(),
            arguments[position][2..]
                .strip_prefix('=')
                .unwrap_or(&arguments[position][2..])
                .into(),
            true,
        )
    } else {
        *index += 1;
        (
            arguments[position].clone(),
            arguments
                .get(*index)
                .ok_or_else(|| format!("{0} requires a value.", arguments[position]))?
                .clone(),
            false,
        )
    };
    let value = match kind {
        "path" => paths.map(&value)?,
        "volume" => paths.volume(&value)?,
        "mount" => paths.mount(&value)?,
        "output" | "secret" | "cache" | "context" => paths.fields(&value, kind)?,
        _ => value,
    };
    if inline {
        arguments[position] = if flag.starts_with("--") {
            format!("{flag}={value}")
        } else {
            format!("{flag}{value}")
        };
    } else {
        arguments[*index] = value;
    }
    Ok(())
}

fn option_name(value: &str) -> &str {
    if value.starts_with("--") {
        value.split('=').next().unwrap_or(value)
    } else if value.starts_with('-') && value.len() > 2 {
        value.get(..2).unwrap_or(value)
    } else {
        value
    }
}

fn endpoint_override(value: &str) -> bool {
    matches!(
        option_name(value),
        "--host"
            | "-H"
            | "--context"
            | "--config"
            | "--tls"
            | "--tlsverify"
            | "--tlscacert"
            | "--tlscert"
            | "--tlskey"
    )
}

fn container_options(
    arguments: &mut [String],
    start: usize,
    paths: &mut Paths<'_>,
    compose: bool,
    exec: bool,
) -> Result<(), String> {
    let mut index = start;
    while index < arguments.len() {
        let argument = &arguments[index];
        if argument == "--" || !argument.starts_with('-') || argument == "-" {
            break;
        }
        if endpoint_override(argument) {
            return Err(
                "Host/context/config/TLS overrides are unsupported. No command was forwarded."
                    .into(),
            );
        }
        if !argument.starts_with("--")
            && argument.len() > 2
            && matches!(option_name(argument), "-d" | "-i" | "-t" | "-T")
            && !argument.contains('=')
            && !argument[1..].chars().all(|value| "ditT".contains(value))
        {
            return Err("Mixed short option groups containing values are unsupported. Write -it -v PATH:/data separately.".into());
        }
        let flag = option_name(argument);
        let kind = match flag {
            "--env-file" | "--env-from-file" => "path",
            "--volume" | "-v" if !exec => "volume",
            "--mount" if !exec && !compose => "mount",
            "--env" | "-e" | "--workdir" | "-w" | "--user" | "-u" | "--detach-keys" => "value",
            "--name" | "--publish" | "-p" | "--network" | "--network-alias" | "--hostname" | "-h" | "--label" | "-l" | "--restart" | "--memory" | "-m" | "--cpus" | "--cpu-shares" | "-c" | "--entrypoint" | "--platform" | "--add-host" | "--attach" | "-a" | "--device" | "--cap-add" | "--cap-drop" | "--security-opt" | "--ulimit" | "--tmpfs" | "--volume-driver" | "--volumes-from" | "--ip" | "--ip6" | "--dns" | "--dns-search" | "--dns-option" | "--health-cmd" | "--health-interval" | "--health-timeout" | "--health-retries" | "--health-start-period" | "--shm-size" | "--stop-signal" | "--stop-timeout" | "--pull" | "--runtime" | "--pid" | "--ipc" | "--cgroupns" | "--log-driver" | "--log-opt" | "--gpus" | "--expose" | "--mac-address" if !exec => "value",
            "--label-file" if !exec => "path",
            "--detach" | "-d" | "--interactive" | "-i" | "--tty" | "-t" | "--privileged" | "--rm" | "--read-only" | "--init" | "--sig-proxy" | "--oom-kill-disable" | "--no-healthcheck" | "--use-aliases" | "--service-ports" | "--no-deps" | "--build" | "--no-TTY" | "-T" | "--quiet-pull" | "--remove-orphans" | "--publish-all" | "-P" | "--help" => "bool",
            _ if !argument.starts_with("--") && argument[1..].chars().all(|value| "ditT".contains(value)) => "bool",
            _ => return Err(format!("Unsupported launcher option before the container/image/service: {argument}. No command was forwarded.")),
        };
        if kind != "bool" {
            take_value(arguments, &mut index, paths, kind)?;
        }
        index += 1;
    }
    Ok(())
}

fn build_options(
    arguments: &mut [String],
    start: usize,
    paths: &mut Paths<'_>,
) -> Result<(), String> {
    let mut index = start;
    while index < arguments.len() {
        if arguments[index] == "--" {
            index += 1;
            continue;
        }
        if !arguments[index].starts_with('-') || arguments[index] == "-" {
            let value = arguments[index].clone();
            if !value.contains("://") && !value.starts_with("git@") {
                arguments[index] = paths.map(&value)?;
            }
        } else {
            let kind = match option_name(&arguments[index]) {
                "--file" | "-f" | "--metadata-file" | "--iidfile" => "path",
                "--output" | "-o" => "output",
                "--secret" => "secret",
                "--cache-from" | "--cache-to" => "cache",
                "--build-context" => "context",
                "--tag" | "-t" | "--build-arg" | "--label" | "--target" | "--platform" | "--progress" | "--network" | "--add-host" | "--ssh" | "--attest" | "--provenance" | "--sbom" | "--ulimit" | "--shm-size" | "--call" => "value",
                "--builder" => return Err("Remote/custom builder selection is unsupported. This launcher uses DockSlate's default builder.".into()),
                "--load" | "--push" | "--no-cache" | "--pull" | "--quiet" | "-q" | "--check" | "--help" => "bool",
                flag => return Err(format!("Unsupported launcher build option: {flag}. No command was forwarded.")),
            };
            if kind != "bool" {
                take_value(arguments, &mut index, paths, kind)?;
            }
        }
        index += 1;
    }
    Ok(())
}

fn rewrite(arguments: &mut [String], paths: &mut Paths<'_>) -> Result<(), String> {
    let mut index = 0;
    while index < arguments.len() && arguments[index].starts_with('-') {
        match option_name(&arguments[index]) {
            "--host" | "-H" | "--context" | "-c" | "--config" | "--tls" | "--tlsverify" | "--tlscacert" | "--tlscert" | "--tlskey" => return Err("Host/context/config/TLS overrides are unsupported. This launcher connects only to DockSlate's owned Docker Engine.".into()),
            "--log-level" | "-l" => take_value(arguments, &mut index, paths, "value")?,
            "--debug" | "-D" | "--help" | "--version" | "-v" => {},
            flag => return Err(format!("Unsupported Docker global option: {flag}.")),
        }
        index += 1;
    }
    let Some(command) = arguments.get(index).cloned() else {
        return Ok(());
    };
    index += 1;
    match command.as_str() {
        "context" => Err("Docker context management is unsupported by this launcher; its endpoint is fixed to DockSlate.".into()),
        "run" | "create" => container_options(arguments, index, paths, false, false),
        "exec" => container_options(arguments, index, paths, false, true),
        "build" => build_options(arguments, index, paths),
        "buildx" if arguments.get(index).is_some_and(|value| value == "build") => build_options(arguments, index + 1, paths),
        "buildx" => Err("This launcher supports docker buildx build only; custom builder endpoint management is unsupported.".into()),
        "container" if arguments.get(index).is_some_and(|value| matches!(value.as_str(), "run" | "create" | "exec" | "cp")) => rewrite(&mut arguments[index..], paths),
        "image" if arguments.get(index).is_some_and(|value| matches!(value.as_str(), "build" | "load" | "save")) => rewrite(&mut arguments[index..], paths),
        "compose" => {
            while index < arguments.len() && arguments[index].starts_with('-') {
                let kind = match option_name(&arguments[index]) {
                    "--file" | "-f" | "--env-file" | "--project-directory" => "path",
                    "--project-name" | "-p" | "--profile" | "--ansi" | "--progress" | "--parallel" => "value",
                    "--all-resources" | "--compatibility" | "--dry-run" | "--help" | "--version" => "bool",
                    flag => return Err(format!("Unsupported launcher Compose global option: {flag}. Place -f/--env-file before the Compose subcommand.")),
                };
                if kind != "bool" { take_value(arguments, &mut index, paths, kind)?; }
                index += 1;
            }
            if arguments.get(index).is_some_and(|value| value == "run" || value == "exec") {
                let exec = arguments[index] == "exec";
                container_options(arguments, index + 1, paths, true, exec)?;
            } else if arguments[index..].iter().any(|value| endpoint_override(value)) {
                return Err("Host/context/config/TLS overrides are unsupported. No command was forwarded.".into());
            }
            Ok(())
        },
        "load" | "save" => {
            while index < arguments.len() {
                if endpoint_override(&arguments[index]) {
                    return Err("Host/context/config/TLS overrides are unsupported. No command was forwarded.".into());
                }
                if matches!(option_name(&arguments[index]), "--input" | "-i" | "--output" | "-o") { take_value(arguments, &mut index, paths, "path")?; }
                index += 1;
            }
            Ok(())
        },
        "cp" => {
            for argument in &mut arguments[index..] {
                if endpoint_override(argument) {
                    return Err("Host/context/config/TLS overrides are unsupported. No command was forwarded.".into());
                }
                if !argument.starts_with('-') && (drive_path(argument) || !argument.contains(':')) { *argument = paths.map(argument)?; }
            }
            Ok(())
        },
        _ => {
            if arguments[index..].iter().any(|value| endpoint_override(value) || option_name(value) == "-c") {
                return Err("Host/context/config/TLS overrides are unsupported. No command was forwarded.".into());
            }
            Ok(())
        },
    }
}

fn run() -> Result<i32, String> {
    let system = system_directory()?;
    let mut arguments: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|value| {
            value
                .into_string()
                .map_err(|_| "Docker arguments must contain valid Unicode.")
        })
        .collect::<Result<_, _>>()?;
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let mut paths = Paths {
        system: &system,
        cwd,
        cache: HashMap::new(),
    };
    let status = runtime_status(&system)?;
    let _lease = acquire_runtime(&status)?;
    let current = runtime_status(&system)?;
    if current["fingerprint"] != status["fingerprint"] {
        return Err(
            "The engine changed during CLI preparation. Retry after setup completes.".into(),
        );
    }
    verify_engine(&system)?;
    let cwd = paths.map(
        paths
            .cwd
            .to_str()
            .ok_or("The current folder must contain valid Unicode.")?
            .to_owned()
            .as_str(),
    )?;
    rewrite(&mut arguments, &mut paths)?;
    let mut command = docker_command(&system, Some(&cwd));
    command
        .args(arguments)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let status = command.status().map_err(|error| error.to_string())?;
    Ok(status.code().unwrap_or(125))
}
