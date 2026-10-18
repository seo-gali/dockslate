use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const SCRIPT: &str = include_str!("../scripts/runtime-control.ps1");
const SETUP: &str = include_str!("../scripts/runtime-setup.sh");
const OUTPUT_LIMIT: usize = 262_144;
const APPROVAL_LIFETIME: Duration = Duration::from_secs(120);
static STATE: OnceLock<Mutex<RuntimeState>> = OnceLock::new();
static MUTATION: Mutex<()> = Mutex::new(());
static ACTIVE: AtomicBool = AtomicBool::new(false);
static READ_STATUS: OnceLock<Mutex<Option<(Instant, Value)>>> = OnceLock::new();

struct Approval {
    expected: Value,
    created: Instant,
}
struct RunningCommand {
    child: Child,
    stdout: JoinHandle<Result<Vec<u8>, String>>,
    stderr: JoinHandle<Result<Vec<u8>, String>>,
}
struct Operation {
    command: RunningCommand,
    state: &'static str,
    started_at: u64,
}
#[derive(Default)]
struct RuntimeState {
    approvals: BTreeMap<String, Approval>,
    active: Option<Operation>,
    last_operation: Option<Value>,
}

fn state() -> &'static Mutex<RuntimeState> {
    STATE.get_or_init(|| Mutex::new(RuntimeState::default()))
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(windows)]
fn system_directory() -> Result<PathBuf, String> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = vec![0u16; 32768];
    let count = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if count == 0 || count as usize >= buffer.len() {
        return Err("The Windows system directory cannot be verified.".into());
    }
    use std::os::windows::ffi::OsStringExt;
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..count as usize],
    )))
}
#[cfg(not(windows))]
fn system_directory() -> Result<PathBuf, String> {
    Err("The DockSlate runtime requires Windows 11 and WSL 2.".into())
}

#[cfg(windows)]
fn new_token() -> Result<String, String> {
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut std::ffi::c_void,
            buffer: *mut u8,
            length: u32,
            flags: u32,
        ) -> i32;
    }
    let mut bytes = [0u8; 32];
    if unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), 32, 2) } < 0 {
        return Err("A secure runtime approval token cannot be generated.".into());
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
#[cfg(not(windows))]
fn new_token() -> Result<String, String> {
    Err("Windows cryptographic approval is unavailable.".into())
}

fn capture(mut stream: impl Read + Send + 'static) -> JoinHandle<Result<Vec<u8>, String>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0u8; 8192];
        let mut exceeded = false;
        loop {
            let count = stream
                .read(&mut buffer)
                .map_err(|_| "Runtime process output could not be read.".to_string())?;
            if count == 0 {
                break;
            }
            let remaining = OUTPUT_LIMIT.saturating_sub(output.len());
            output.extend_from_slice(&buffer[..count.min(remaining)]);
            exceeded |= count > remaining;
        }
        if exceeded {
            Err("Runtime output exceeded its limit. The operation result is unverified.".into())
        } else {
            Ok(output)
        }
    })
}

fn launch(request: Value) -> Result<RunningCommand, String> {
    let program = system_directory()?.join("WindowsPowerShell/v1.0/powershell.exe");
    if !program.is_file() {
        return Err("Windows PowerShell is unavailable.".into());
    }
    let mut command = Command::new(&program);
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "& ([scriptblock]::Create([Console]::In.ReadToEnd()))",
    ]);
    command.env("DOCKSLATE_RUNTIME_REQUEST", request.to_string());
    command.env("DOCKSLATE_RUNTIME_SETUP", SETUP.replace("\r\n", "\n"));
    command.env(
        "PSModulePath",
        program
            .parent()
            .ok_or("PowerShell path is invalid.")?
            .join("Modules"),
    );
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "The fixed runtime command could not start.".to_string())?;
    let stdout = capture(
        child
            .stdout
            .take()
            .ok_or("The runtime output pipe is unavailable.")?,
    );
    let stderr = capture(
        child
            .stderr
            .take()
            .ok_or("The runtime error pipe is unavailable.")?,
    );
    let mut stdin = child
        .stdin
        .take()
        .ok_or("The runtime input pipe is unavailable.")?;
    if let Err(error) = stdin.write_all(SCRIPT.as_bytes()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "The fixed runtime script could not be supplied: {error}"
        ));
    }
    drop(stdin);
    Ok(RunningCommand {
        child,
        stdout,
        stderr,
    })
}

fn finish(command: RunningCommand, succeeded: bool) -> Result<Value, String> {
    let stdout = command
        .stdout
        .join()
        .map_err(|_| "Runtime output capture failed.".to_string())??;
    let _stderr = command
        .stderr
        .join()
        .map_err(|_| "Runtime error capture failed.".to_string())??;
    let value: Value = serde_json::from_slice(&stdout).map_err(|_| "The runtime command returned an incomplete result. Inspect the owned runtime before retrying.".to_string())?;
    if !succeeded {
        return Err(value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The runtime operation failed.")
            .into());
    }
    Ok(value)
}

fn inspect(mode: &str) -> Result<Value, String> {
    let mut command = launch(json!({"mode":mode}))?;
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        if let Some(exit) = command
            .child
            .try_wait()
            .map_err(|_| "Runtime inspection process status is unknown.".to_string())?
        {
            return finish(command, exit.success());
        }
        if Instant::now() >= deadline {
            let _ = command.child.kill();
            let _ = command.child.wait();
            let _ = command.stdout.join();
            let _ = command.stderr.join();
            return Err("Read-only runtime inspection timed out. Ownership and WSL state remain unverified.".into());
        }
        thread::sleep(Duration::from_millis(30));
    }
}

fn poll_operation() -> Result<Option<Value>, String> {
    let mut guard = state()
        .lock()
        .map_err(|_| "Runtime operation tracking is unavailable.".to_string())?;
    if let Some(active) = guard.active.as_mut() {
        let exit = active.command.child.try_wait().map_err(|_| {
            "Runtime operation status is unknown. The process remains tracked; do not retry."
                .to_string()
        })?;
        if let Some(exit) = exit
            .filter(|_| active.command.stdout.is_finished() && active.command.stderr.is_finished())
        {
            let active = guard
                .active
                .take()
                .ok_or("The tracked runtime operation is unavailable.")?;
            let result = match finish(active.command, exit.success()) {
                Ok(value) => {
                    json!({"state":if value["state"] == "failed" { "failed" } else { "completed" },"message":value["message"],"startedAt":active.started_at,"completedAt":now_ms()})
                }
                Err(message) => {
                    json!({"state":"failed","message":message,"startedAt":active.started_at,"completedAt":now_ms()})
                }
            };
            guard.last_operation = Some(result);
            ACTIVE.store(false, Ordering::Release);
        } else {
            return Ok(Some(
                json!({"state":active.state,"message":"The owned runtime operation is still running.","processId":active.command.child.id(),"startedAt":active.started_at}),
            ));
        }
    }
    Ok(guard.last_operation.clone())
}

pub fn is_mutating() -> bool {
    ACTIVE.load(Ordering::Acquire)
}

pub fn inspect_status() -> Result<Value, String> {
    let local_operation = poll_operation()?;
    let mut result = inspect("status")?;
    if let Some(object) = result.as_object_mut() {
        if let Some(operation) = local_operation {
            if is_mutating() {
                object.insert("state".into(), operation["state"].clone());
                if object.get("operation").is_none_or(Value::is_null) {
                    object.insert("operation".into(), operation);
                }
            } else if object.get("operation").is_none_or(Value::is_null) {
                object.insert("operation".into(), operation);
            }
        }
    }
    if let Ok(mut cached) = READ_STATUS.get_or_init(|| Mutex::new(None)).lock() {
        *cached = if result["state"] == "running" && result["keeperVerified"] == true {
            Some((Instant::now(), result.clone()))
        } else {
            None
        };
    }
    Ok(result)
}

pub fn public_status(mut result: Value) -> Value {
    if let Some(object) = result.as_object_mut() {
        object.remove("fingerprint");
    }
    result
}

pub fn status() -> Result<Value, String> {
    inspect_status().map(public_status)
}

pub fn installation_preview() -> Result<Value, String> {
    let _guard = MUTATION
        .try_lock()
        .map_err(|_| "Another runtime request is being prepared.".to_string())?;
    let _disk_guard = crate::wsl::runtime_mutation_guard()?;
    let _ = poll_operation()?;
    if is_mutating()
        || crate::wsl::is_compacting()
        || crate::compose::is_busy()
        || crate::builds::is_busy()
        || crate::volumes::is_busy()
    {
        return Err("A runtime or disk operation is already running.".into());
    }
    let mut result = inspect("preview")?;
    let object = result
        .as_object_mut()
        .ok_or("The runtime installation preview is invalid.")?;
    let expected = object.remove("fingerprint").unwrap_or(Value::Null);
    object.insert("token".into(), Value::Null);
    object.insert("expiresAt".into(), Value::Null);
    if object.get("eligible").and_then(Value::as_bool) == Some(true) && !expected.is_null() {
        let token = new_token()?;
        let mut guard = state()
            .lock()
            .map_err(|_| "Runtime approval state is unavailable.".to_string())?;
        guard
            .approvals
            .retain(|_, approval| approval.created.elapsed() < APPROVAL_LIFETIME);
        if guard.approvals.len() >= 16 {
            guard.approvals.clear();
        }
        guard.approvals.insert(
            token.clone(),
            Approval {
                expected,
                created: Instant::now(),
            },
        );
        object.insert("token".into(), json!(token));
        object.insert(
            "expiresAt".into(),
            json!(now_ms() + APPROVAL_LIFETIME.as_millis() as u64),
        );
    }
    Ok(result)
}

fn begin(mode: &str, operation_state: &'static str, expected: Value) -> Result<Value, String> {
    {
        let mut guard = state()
            .lock()
            .map_err(|_| "Runtime operation tracking is unavailable.".to_string())?;
        let command = launch(json!({"mode":mode,"approved":true,"expected":expected}))?;
        guard.approvals.clear();
        guard.last_operation = None;
        guard.active = Some(Operation {
            command,
            state: operation_state,
            started_at: now_ms(),
        });
        ACTIVE.store(true, Ordering::Release);
    }
    thread::spawn(|| {
        while ACTIVE.load(Ordering::Acquire) {
            if poll_operation().is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(200));
        }
    });
    // Mutation tracking without timeout termination.
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let operation = poll_operation()?.ok_or("The runtime operation has no tracked result.")?;
        if operation["state"] == "failed" {
            return Err(operation["message"]
                .as_str()
                .unwrap_or("The runtime operation failed.")
                .into());
        }
        if operation["state"] == "completed" {
            return status();
        }
        if Instant::now() >= deadline {
            return Ok(
                json!({"state":operation_state,"message":"The owned runtime operation has started. Refresh its status to see progress."}),
            );
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn require_idle() -> Result<(), String> {
    let _ = poll_operation()?;
    if is_mutating() || crate::wsl::is_compacting() {
        return Err("A runtime or disk operation is already running.".into());
    }
    Ok(())
}

pub fn install(token: String, approved: bool) -> Result<Value, String> {
    if !approved {
        return Err("Explicit approval is required to download and create the separate DockSlate WSL runtime.".into());
    }
    let _guard = MUTATION
        .try_lock()
        .map_err(|_| "Another runtime request is being prepared.".to_string())?;
    let _disk_guard = crate::wsl::runtime_mutation_guard()?;
    require_idle()?;
    let approval = state()
        .lock()
        .map_err(|_| "Runtime approval state is unavailable.".to_string())?
        .approvals
        .remove(&token)
        .ok_or(
            "The runtime installation preview is unknown or already used. Create a new preview.",
        )?;
    if approval.created.elapsed() >= APPROVAL_LIFETIME {
        return Err("The runtime installation approval expired. Create a new preview.".into());
    }
    begin("install", "installing", approval.expected)
}

fn change_state(
    mode: &str,
    required: &str,
    operation_state: &'static str,
    approved: bool,
) -> Result<Value, String> {
    if !approved {
        return Err(format!(
            "Explicit approval is required to {mode} the owned DockSlate distribution."
        ));
    }
    let _guard = MUTATION
        .try_lock()
        .map_err(|_| "Another runtime request is being prepared.".to_string())?;
    let _disk_guard = crate::wsl::runtime_mutation_guard()?;
    require_idle()?;
    let current = inspect("status")?;
    if current["state"] != required {
        return Err(current["message"]
            .as_str()
            .unwrap_or("The owned runtime is not in the required state.")
            .into());
    }
    let expected = current
        .get("fingerprint")
        .cloned()
        .filter(|value| !value.is_null())
        .ok_or("Runtime ownership cannot be verified.")?;
    begin(mode, operation_state, expected)
}
pub fn start(approved: bool) -> Result<Value, String> {
    change_state("start", "stopped", "starting", approved)
}
pub fn stop(approved: bool) -> Result<Value, String> {
    change_state("stop", "running", "stopping", approved)
}

// Operation-scoped ownership lease.
struct ReadGuard {
    #[cfg(windows)]
    lease: native_guard::Lease,
}
impl ReadGuard {
    fn acquire(owner: &str, fingerprint: &Value) -> Result<Self, String> {
        #[cfg(windows)]
        {
            Ok(Self {
                lease: native_guard::Lease::acquire(owner, fingerprint)?,
            })
        }
        #[cfg(not(windows))]
        {
            let _ = (owner, fingerprint);
            Err("Native owned runtime validation requires Windows.".into())
        }
    }
    fn validate(&self, owner: &str, fingerprint: &Value) -> Result<(), String> {
        #[cfg(windows)]
        {
            self.lease.validate(owner, fingerprint)
        }
        #[cfg(not(windows))]
        {
            let _ = (owner, fingerprint);
            Err("Native owned runtime validation requires Windows.".into())
        }
    }
}

#[cfg(windows)]
mod native_guard {
    use super::*;
    use std::{
        ffi::c_void,
        os::windows::{
            ffi::OsStrExt,
            fs::OpenOptionsExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        path::Path,
    };

    type Handle = *mut c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileAttributesW(path: *const u16) -> u32;
        fn GetFullPathNameW(
            path: *const u16,
            size: u32,
            buffer: *mut u16,
            part: *mut *mut u16,
        ) -> u32;
        fn ExpandEnvironmentStringsW(value: *const u16, buffer: *mut u16, size: u32) -> u32;
        fn OpenProcess(access: u32, inherit: i32, id: u32) -> Handle;
        fn GetProcessTimes(
            process: Handle,
            created: *mut u64,
            exited: *mut u64,
            kernel: *mut u64,
            user: *mut u64,
        ) -> i32;
        fn QueryFullProcessImageNameW(
            process: Handle,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegOpenKeyExW(
            key: Handle,
            name: *const u16,
            options: u32,
            access: u32,
            result: *mut Handle,
        ) -> i32;
        fn RegQueryValueExW(
            key: Handle,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            size: *mut u32,
        ) -> i32;
        fn RegEnumKeyExW(
            key: Handle,
            index: u32,
            name: *mut u16,
            size: *mut u32,
            reserved: *mut u32,
            class: *mut u16,
            class_size: *mut u32,
            written: *mut u64,
        ) -> i32;
        fn RegCloseKey(key: Handle) -> i32;
    }

    fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
        value.as_ref().encode_wide().chain(Some(0)).collect()
    }
    fn changed() -> String {
        "The owned runtime stopped or its ownership changed. Refresh the connection.".into()
    }
    fn normalize(value: &str) -> Result<String, String> {
        let value = value.strip_prefix("\\\\?\\").unwrap_or(value);
        let bytes = value.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1..3] != *b":\\"
            || value[2..].contains(':')
            || value.contains('\0')
        {
            return Err(changed());
        }
        let mut buffer = vec![0u16; 32768];
        let size = unsafe {
            GetFullPathNameW(
                wide(value).as_ptr(),
                buffer.len() as u32,
                buffer.as_mut_ptr(),
                std::ptr::null_mut(),
            )
        };
        if size == 0 || size as usize >= buffer.len() {
            return Err(changed());
        }
        Ok(String::from_utf16_lossy(&buffer[..size as usize])
            .trim_end_matches('\\')
            .to_lowercase())
    }
    fn plain_path(path: &Path) -> Result<(), String> {
        for ancestor in path.ancestors() {
            let attributes = unsafe { GetFileAttributesW(wide(ancestor).as_ptr()) };
            if attributes == u32::MAX || attributes & 0x400 != 0 {
                return Err(changed());
            }
        }
        Ok(())
    }
    fn pin(path: &Path, directory: bool) -> Result<File, String> {
        plain_path(path)?;
        let mut options = OpenOptions::new();
        options
            .read(true)
            .share_mode(if directory { 3 } else { 1 })
            .custom_flags(0x00200000 | if directory { 0x02000000 } else { 0 });
        let file = options.open(path).map_err(|_| "The owned runtime is changing or its validation files cannot be locked. Retry after the runtime operation completes.".to_owned())?;
        if file.metadata().map_err(|_| changed())?.is_dir() != directory {
            return Err(changed());
        }
        Ok(file)
    }
    fn pinned_json(file: &mut File) -> Result<Value, String> {
        let size = file.metadata().map_err(|_| changed())?.len();
        if size == 0 || size > 131072 {
            return Err(changed());
        }
        let mut body = Vec::new();
        file.read_to_end(&mut body).map_err(|_| changed())?;
        serde_json::from_slice(&body).map_err(|_| changed())
    }

    struct Registry(Handle);
    impl Drop for Registry {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    impl Registry {
        fn open(key: Handle, name: &str) -> Result<Self, String> {
            let mut result = std::ptr::null_mut();
            if unsafe { RegOpenKeyExW(key, wide(name).as_ptr(), 0, 0x20019, &mut result) } != 0 {
                return Err(changed());
            }
            Ok(Self(result))
        }
        fn value(&self, name: &str, optional: bool) -> Result<Option<(u32, Vec<u8>)>, String> {
            let mut kind = 0;
            let mut bytes = vec![0u8; 65536];
            let mut size = bytes.len() as u32;
            let code = unsafe {
                RegQueryValueExW(
                    self.0,
                    wide(name).as_ptr(),
                    std::ptr::null_mut(),
                    &mut kind,
                    bytes.as_mut_ptr(),
                    &mut size,
                )
            };
            if code == 2 && optional {
                return Ok(None);
            }
            if code != 0 || size as usize > bytes.len() {
                return Err(changed());
            }
            bytes.truncate(size as usize);
            Ok(Some((kind, bytes)))
        }
        fn string(&self, name: &str, default: Option<&str>) -> Result<String, String> {
            let Some((kind, bytes)) = self.value(name, default.is_some())? else {
                return Ok(default.unwrap_or_default().into());
            };
            if ![1, 2].contains(&kind) || bytes.len() % 2 != 0 {
                return Err(changed());
            }
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|byte| u16::from_le_bytes([byte[0], byte[1]]))
                .collect();
            let value = String::from_utf16(&units)
                .map_err(|_| changed())?
                .trim_end_matches('\0')
                .to_owned();
            if kind == 2 {
                let mut expanded = vec![0u16; 32768];
                let size = unsafe {
                    ExpandEnvironmentStringsW(
                        wide(&value).as_ptr(),
                        expanded.as_mut_ptr(),
                        expanded.len() as u32,
                    )
                };
                if size == 0 || size as usize > expanded.len() {
                    return Err(changed());
                }
                return String::from_utf16(&expanded[..size as usize - 1]).map_err(|_| changed());
            }
            Ok(value)
        }
        fn number(&self, name: &str) -> Result<u32, String> {
            let Some((kind, bytes)) = self.value(name, false)? else {
                return Err(changed());
            };
            if kind != 4 || bytes.len() != 4 {
                return Err(changed());
            }
            Ok(u32::from_le_bytes(bytes.try_into().map_err(|_| changed())?))
        }
    }
    fn registration(owner: &str, fingerprint: &Value) -> Result<(), String> {
        let registry = Registry::open(
            -2147483647isize as Handle,
            "Software\\Microsoft\\Windows\\CurrentVersion\\Lxss",
        )?;
        let owner = normalize(owner)?;
        let mut matched = 0;
        for index in 0..1024 {
            let mut name = [0u16; 256];
            let mut size = name.len() as u32;
            let code = unsafe {
                RegEnumKeyExW(
                    registry.0,
                    index,
                    name.as_mut_ptr(),
                    &mut size,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if code == 259 {
                return if matched == 1 { Ok(()) } else { Err(changed()) };
            }
            if code != 0 || size as usize > name.len() {
                return Err(changed());
            }
            let name = String::from_utf16(&name[..size as usize]).map_err(|_| changed())?;
            let entry = Registry::open(registry.0, &name)?;
            let distribution = entry.string("DistributionName", None)?;
            let path = entry.string("BasePath", None)?;
            if distribution.eq_ignore_ascii_case("DockSlate") {
                matched += 1;
                if distribution != "DockSlate"
                    || fingerprint["registrationId"].as_str() != Some(name.as_str())
                    || normalize(&path)? != owner
                    || entry.number("Version")? != 2
                    || entry.string("VhdFileName", Some("ext4.vhdx"))? != "ext4.vhdx"
                {
                    return Err(changed());
                }
            } else if normalize(&path).ok().as_deref() == Some(owner.as_str()) {
                return Err(changed());
            }
        }
        Err("WSL registration inventory exceeds its validation limit.".into())
    }

    pub struct Lease {
        _pins: Vec<File>,
        keeper: OwnedHandle,
    }
    impl Lease {
        pub fn acquire(owner: &str, fingerprint: &Value) -> Result<Self, String> {
            let directory = Path::new(owner);
            let root = directory.parent().ok_or_else(changed)?;
            let lock = pin(&root.join("mutation.lock"), false)?;
            let mut marker_file = pin(&root.join("ownership.json"), false)?;
            let mut keeper_file = pin(&root.join("keeper.json"), false)?;
            let marker = pinned_json(&mut marker_file)?;
            let keeper = pinned_json(&mut keeper_file)?;
            if marker["schema"] != 1
                || marker["owner"] != "DockSlate"
                || marker["distribution"] != "DockSlate"
                || marker["state"] != "installed"
                || keeper["distribution"] != "DockSlate"
                || keeper["installId"] != marker["installId"]
            {
                return Err(changed());
            }
            for key in [
                "registrationId",
                "installId",
                "engineVersion",
                "rootfsSha256",
            ] {
                if marker.get(key) != fingerprint.get(key) || marker[key].as_str().is_none() {
                    return Err(changed());
                }
            }
            if normalize(marker["installPath"].as_str().ok_or_else(changed)?)? != normalize(owner)?
                || normalize(fingerprint["installPath"].as_str().ok_or_else(changed)?)?
                    != normalize(owner)?
            {
                return Err(changed());
            }
            let pid = keeper["processId"]
                .as_u64()
                .and_then(|id| u32::try_from(id).ok())
                .filter(|id| *id != 0)
                .ok_or_else(changed)?;
            let handle = unsafe { OpenProcess(0x00101000, 0, pid) };
            if handle.is_null() {
                return Err(changed());
            }
            let keeper_handle = unsafe { OwnedHandle::from_raw_handle(handle) };
            let (mut created, mut exited, mut kernel, mut user) = (0u64, 0u64, 0u64, 0u64);
            if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
                == 0
                || keeper["startedTicks"]
                    .as_str()
                    .and_then(|ticks| ticks.parse::<u64>().ok())
                    != created.checked_add(504911232000000000)
            {
                return Err(changed());
            }
            let mut program = vec![0u16; 32768];
            let mut size = program.len() as u32;
            if unsafe { QueryFullProcessImageNameW(handle, 0, program.as_mut_ptr(), &mut size) }
                == 0
            {
                return Err(changed());
            }
            let program = String::from_utf16(&program[..size as usize]).map_err(|_| changed())?;
            let wsl = system_directory()?.join("wsl.exe");
            if normalize(&program)? != normalize(wsl.to_str().ok_or_else(changed)?)? {
                return Err(changed());
            }
            let disk = directory.join("ext4.vhdx");
            plain_path(&disk)?;
            if !disk.is_file() {
                return Err(changed());
            }
            let lease = Self {
                _pins: vec![
                    lock,
                    marker_file,
                    keeper_file,
                    pin(root, true)?,
                    pin(directory, true)?,
                ],
                keeper: keeper_handle,
            };
            lease.validate(owner, fingerprint)?;
            Ok(lease)
        }
        pub fn validate(&self, owner: &str, fingerprint: &Value) -> Result<(), String> {
            if unsafe { WaitForSingleObject(self.keeper.as_raw_handle(), 0) } != 258 {
                return Err(changed());
            }
            plain_path(Path::new(owner))?;
            registration(owner, fingerprint)
        }
    }
}

#[derive(Clone)]
pub struct Transport {
    pub owner: String,
    pub context: String,
    fingerprint: Value,
    guard: Arc<ReadGuard>,
}
impl Transport {
    fn verify(&self, mutation: bool) -> Result<(), String> {
        if is_mutating() || crate::wsl::is_compacting() {
            return Err("A runtime or disk operation is running; Docker access is blocked.".into());
        }
        self.guard.validate(&self.owner, &self.fingerprint)?;
        if mutation {
            let current = inspect("status")?;
            if current["state"] != "running"
                || current["keeperVerified"] != true
                || current.get("fingerprint") != Some(&self.fingerprint)
            {
                return Err(
                    "The owned runtime stopped or its ownership changed. Refresh the connection."
                        .into(),
                );
            }
        }
        Ok(())
    }

    pub(crate) fn build_path(&self, windows_path: &str) -> Result<String, String> {
        self.verify(false)?;
        let output = crate::process::execute(
            &system_directory()?.join("wsl.exe"),
            &[
                "--distribution".into(),
                "DockSlate".into(),
                "--user".into(),
                "root".into(),
                "--exec".into(),
                "/usr/bin/wslpath".into(),
                "-a".into(),
                "-u".into(),
                windows_path.into(),
            ],
            None,
            Duration::from_secs(15),
            65536,
        )?;
        if !output.status.success() {
            return Err("빌드 폴더를 DockSlate WSL 경로로 변환하지 못했습니다.".into());
        }
        let path = String::from_utf8(output.stdout)
            .map_err(|_| "WSL 경로 인코딩을 확인할 수 없습니다.")?;
        let path = path.trim_end_matches(['\r', '\n']);
        if !path.starts_with('/') || path.chars().any(char::is_control) || path.len() > 65535 {
            return Err("WSL 빌드 경로를 확인할 수 없습니다.".into());
        }
        Ok(path.into())
    }

    pub(crate) fn spawn_configured_image_build(
        &self,
        context: &str,
        dockerfile: &str,
        tag: &str,
        no_cache: bool,
        builder: &str,
    ) -> Result<Child, String> {
        if builder.is_empty()
            || builder.len() > 128
            || !builder
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        {
            return Err("Invalid internal Buildx builder name.".into());
        }
        self.verify(true)?;
        let mut command = Command::new(system_directory()?.join("wsl.exe"));
        command.args([
            "--distribution",
            "DockSlate",
            "--user",
            "root",
            "--exec",
            "/usr/bin/docker",
            "--host",
            "unix:///var/run/docker.sock",
            "buildx",
            "build",
            "--builder",
            builder,
            "--load",
            "--progress=plain",
            "--file",
            dockerfile,
            "--tag",
            tag,
        ]);
        if no_cache {
            command.arg("--no-cache");
        }
        command.arg("--").arg(context);
        for name in [
            "DOCKER_HOST",
            "DOCKER_CONTEXT",
            "DOCKER_CONFIG",
            "BUILDX_BUILDER",
            "BUILDX_CONFIG",
        ] {
            command.env_remove(name);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
            .spawn()
            .map_err(|error| format!("DockSlate 이미지 빌드를 시작할 수 없습니다: {error}"))
    }

    pub fn discover() -> Result<Self, String> {
        let cached = READ_STATUS
            .get_or_init(|| Mutex::new(None))
            .lock()
            .ok()
            .and_then(|cached| {
                cached
                    .as_ref()
                    .filter(|(at, _)| at.elapsed() < Duration::from_secs(30))
                    .map(|(_, value)| value.clone())
            });
        if let Some(current) = cached {
            if let Ok(transport) = Self::from_status(&current) {
                return Ok(transport);
            }
            if let Ok(mut cached) = READ_STATUS.get().unwrap().lock() {
                *cached = None;
            }
        }
        Self::from_status(&inspect_status()?)
    }
    pub fn from_status(current: &Value) -> Result<Self, String> {
        let _ = poll_operation()?;
        if is_mutating() || crate::wsl::is_compacting() {
            return Err("A runtime or disk operation is running; Docker access is blocked.".into());
        }
        if matches!(
            current["state"].as_str(),
            Some("installing" | "starting" | "stopping")
        ) {
            return Err("A runtime or disk operation is running; Docker access is blocked.".into());
        }
        if current["state"] != "running" || current["keeperVerified"] != true {
            return Err(current["message"]
                .as_str()
                .unwrap_or("The owned DockSlate runtime is unavailable.")
                .into());
        }
        let owner: String = current["installPath"]
            .as_str()
            .ok_or("The owned runtime path is unavailable.")?
            .into();
        let fingerprint = current
            .get("fingerprint")
            .cloned()
            .filter(|value| !value.is_null())
            .ok_or("The runtime ownership fingerprint is unavailable.")?;
        let guard = Arc::new(ReadGuard::acquire(&owner, &fingerprint)?);
        Ok(Self {
            owner,
            context: "dockslate".into(),
            fingerprint,
            guard,
        })
    }
    pub fn request(
        &self,
        method: &str,
        path: &str,
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        self.request_inner(method, path, None, timeout, limit)
    }

    pub(crate) fn archive_stat(&self, api: &str, id: &str, path: &str) -> Result<Vec<u8>, String> {
        let valid_api = api
            .strip_prefix("1.")
            .and_then(|minor| minor.parse::<u32>().ok())
            .is_some_and(|minor| (41..=55).contains(&minor));
        if !valid_api
            || id.len() != 64
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || !path.starts_with('/')
            || path.len() > 4096
            || path.contains('\0')
            || path.split('/').any(|part| matches!(part, "." | ".."))
            || path.split('/').filter(|part| !part.is_empty()).count() > 32
        {
            return Err("Invalid internal container archive metadata request.".into());
        }
        self.verify(false)?;
        let encoded: String = path
            .bytes()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                    (byte as char).to_string()
                } else {
                    format!("%{byte:02X}")
                }
            })
            .collect();
        let args = [
            "--distribution".into(),
            "DockSlate".into(),
            "--user".into(),
            "root".into(),
            "--exec".into(),
            "/usr/bin/curl".into(),
            "--disable".into(),
            "--silent".into(),
            "--show-error".into(),
            "--noproxy".into(),
            "*".into(),
            "--unix-socket".into(),
            "/var/run/docker.sock".into(),
            "--proto".into(),
            "=http".into(),
            "--head".into(),
            "--max-time".into(),
            "5".into(),
            "--write-out".into(),
            "\n%{http_code}".into(),
            "--".into(),
            format!("http://localhost/v{api}/containers/{id}/archive?path={encoded}"),
        ];
        let output = crate::process::execute(
            &system_directory()?.join("wsl.exe"),
            &args,
            None,
            Duration::from_secs(7),
            8192,
        )?;
        if !output.status.success() {
            return Err("컨테이너 경로 정보를 읽지 못했거나 응답 시간이 초과되었습니다.".into());
        }
        let text = std::str::from_utf8(&output.stdout)
            .map_err(|_| "컨테이너 경로 응답 형식이 올바르지 않습니다.")?;
        let (headers, status) = text
            .rsplit_once('\n')
            .ok_or("컨테이너 경로 응답 상태를 확인하지 못했습니다.")?;
        let code = status
            .parse::<u16>()
            .map_err(|_| "컨테이너 경로 응답 상태를 확인하지 못했습니다.")?;
        if !(200..300).contains(&code) {
            return Err(format!(
                "컨테이너 경로를 확인하지 못했습니다 (Docker HTTP {code})."
            ));
        }
        let mut values = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .filter(|(key, _)| key.eq_ignore_ascii_case("X-Docker-Container-Path-Stat"))
            .map(|(_, value)| value.trim());
        let metadata = values
            .next()
            .filter(|value| !value.is_empty())
            .ok_or("컨테이너 경로 정보 헤더가 없습니다.")?;
        if values.next().is_some() {
            return Err("컨테이너 경로 정보 헤더가 중복되었습니다.".into());
        }
        Ok(metadata.as_bytes().to_vec())
    }

    pub(crate) fn create_container(
        &self,
        api: &str,
        name: &str,
        body: &[u8],
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        self.create_json(api, "containers", name, body, timeout, limit)
    }

    pub(crate) fn create_network(
        &self,
        api: &str,
        body: &[u8],
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        self.create_json(api, "networks", "", body, timeout, limit)
    }

    pub(crate) fn create_volume(
        &self,
        api: &str,
        body: &[u8],
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        self.create_json(api, "volumes", "", body, timeout, limit)
    }

    pub(crate) fn verify_tool_session(&self) -> Result<(), String> {
        self.verify(false)
    }
    pub(crate) fn verify_tool_start(&self) -> Result<(), String> {
        self.verify(true)
    }

    pub(crate) fn buildx_command(
        &self,
        arguments: &[String],
        mutation: bool,
        input: Option<&[u8]>,
        timeout: Duration,
        limit: usize,
    ) -> Result<std::process::Output, String> {
        if arguments.is_empty() || arguments.iter().any(|arg| arg.contains('\0')) {
            return Err("Invalid internal Buildx request.".into());
        }
        self.verify(mutation)?;
        let mut args: Vec<String> = [
            "--distribution",
            "DockSlate",
            "--user",
            "root",
            "--exec",
            "/usr/bin/env",
            "-u",
            "DOCKER_HOST",
            "-u",
            "DOCKER_CONTEXT",
            "-u",
            "DOCKER_CONFIG",
            "-u",
            "BUILDX_BUILDER",
            "-u",
            "BUILDX_CONFIG",
            "/usr/bin/docker",
            "--host",
            "unix:///var/run/docker.sock",
            "buildx",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        args.extend_from_slice(arguments);
        crate::process::execute(
            &system_directory()?.join("wsl.exe"),
            &args,
            input,
            timeout,
            limit,
        )
    }

    pub(crate) fn spawn_volume_files(
        &self,
        request: &Value,
        mutation: bool,
    ) -> Result<Child, String> {
        self.verify(mutation)?;
        let serialized =
            serde_json::to_string(request).map_err(|_| "Invalid internal volume request.")?;
        if serialized.len() > 16384 {
            return Err("Volume request is too large.".into());
        }
        let mut command = Command::new(system_directory()?.join("wsl.exe"));
        command.args([
            "--distribution",
            "DockSlate",
            "--user",
            "root",
            "--exec",
            "/usr/bin/timeout",
            "--signal=TERM",
            "--kill-after=5s",
            "910s",
            "/usr/bin/python3",
            "-I",
            "-",
            &serialized,
        ]);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| {
            "볼륨 파일 작업을 시작할 수 없습니다. DockSlate 엔진과 Python 3을 확인하세요."
        })?;
        let mut input = child
            .stdin
            .take()
            .ok_or("Volume helper input is unavailable.")?;
        if input
            .write_all(include_bytes!("../scripts/volume-files.py"))
            .is_err()
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "볼륨 파일 도구를 시작하지 못했습니다. 전용 WSL의 Python 3 지원을 확인하세요."
                    .into(),
            );
        }
        drop(input);
        Ok(child)
    }

    fn create_json(
        &self,
        api: &str,
        resource: &str,
        name: &str,
        body: &[u8],
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        let valid_api = api
            .strip_prefix("1.")
            .and_then(|minor| minor.parse::<u32>().ok())
            .is_some_and(|minor| (41..=55).contains(&minor));
        let valid_name = name.is_empty()
            || (name.len() <= 128
                && name.as_bytes()[0].is_ascii_alphanumeric()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte)));
        if !valid_api
            || !valid_name
            || !["containers", "networks", "volumes"].contains(&resource)
            || (resource != "containers" && !name.is_empty())
            || body.is_empty()
            || body.len() > 64 * 1024
        {
            return Err("Invalid internal Docker create request.".into());
        }
        let query = if name.is_empty() {
            String::new()
        } else {
            format!("?name={name}")
        };
        self.request_inner(
            "POST",
            &format!("/v{api}/{resource}/create{query}"),
            Some(body),
            timeout,
            limit,
        )
    }

    fn request_inner(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        if !["GET", "POST", "DELETE"].contains(&method)
            || !path.starts_with('/')
            || path.len() > 4096
            || path
                .bytes()
                .any(|byte| byte <= 32 || byte >= 127 || matches!(byte, b'#' | b'\\'))
            || timeout.is_zero()
            || limit == 0
            || limit > 32 * 1024 * 1024
        {
            return Err("Invalid internal Docker request.".into());
        }
        self.verify(method != "GET")?;
        let program = system_directory()?.join("wsl.exe");
        let seconds = timeout.as_secs_f64().max(0.1).to_string();
        let mut args = vec![
            "--distribution".into(),
            "DockSlate".into(),
            "--user".into(),
            "root".into(),
            "--exec".into(),
            "/usr/bin/curl".into(),
            "--disable".into(),
            "--silent".into(),
            "--show-error".into(),
            "--noproxy".into(),
            "*".into(),
            "--unix-socket".into(),
            "/var/run/docker.sock".into(),
            "--proto".into(),
            "=http".into(),
            "--request".into(),
            method.into(),
            "--max-time".into(),
            seconds,
            "--max-filesize".into(),
            limit.to_string(),
            "--write-out".into(),
            "\n%{http_code}".into(),
        ];
        if body.is_some() {
            args.extend([
                "--header".into(),
                "Content-Type: application/json".into(),
                "--data-binary".into(),
                "@-".into(),
            ]);
        }
        args.extend(["--".into(), format!("http://localhost{path}")]);
        let output = crate::process::execute(
            &program,
            &args,
            body,
            timeout + Duration::from_secs(2),
            limit.saturating_add(4096),
        )?;
        if !output.status.success() {
            return Err("The owned Docker socket request failed or timed out; a mutation outcome may be unknown. Refresh before retrying.".into());
        }
        let split = output
            .stdout
            .len()
            .checked_sub(4)
            .ok_or("The Docker response has no HTTP status.")?;
        if output.stdout[split] != b'\n' {
            return Err("The Docker response has an invalid HTTP status.".into());
        }
        let code = std::str::from_utf8(&output.stdout[split + 1..])
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .ok_or("The Docker response has an invalid HTTP status.")?;
        let body = &output.stdout[..split];
        if body.len() > limit {
            return Err("The Docker response exceeds its safety limit.".into());
        }
        if !(200..300).contains(&code) {
            let message = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|value| value["message"].as_str().map(str::to_owned))
                .unwrap_or_else(|| format!("Docker HTTP {code}"));
            return Err(format!(
                "Docker HTTP {code}: {}",
                message.chars().take(1000).collect::<String>()
            ));
        }
        Ok(body.to_vec())
    }
}
