use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const SCRIPT: &str = include_str!("../scripts/runtime-control.ps1");
const SETUP: &str = include_str!("../scripts/runtime-setup.sh");
const READY: &str = include_str!("../scripts/runtime-ready.sh");
const OUTPUT_LIMIT: usize = 262_144;
const APPROVAL_LIFETIME: Duration = Duration::from_secs(120);
static STATE: OnceLock<Mutex<RuntimeState>> = OnceLock::new();
static MUTATION: Mutex<()> = Mutex::new(());
static ACTIVE: AtomicBool = AtomicBool::new(false);

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
pub(crate) fn system_directory() -> Result<PathBuf, String> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = [0u16; 32768];
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
pub(crate) fn system_directory() -> Result<PathBuf, String> {
    Err("The DockSlate runtime requires Windows 11 and WSL 2.".into())
}

#[cfg(windows)]
pub(crate) fn new_token() -> Result<String, String> {
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
pub(crate) fn new_token() -> Result<String, String> {
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
    command.env("DOCKSLATE_RUNTIME_READY", READY.replace("\r\n", "\n"));
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

pub(crate) fn inspect(mode: &str) -> Result<Value, String> {
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

pub(crate) fn poll_operation() -> Result<Option<Value>, String> {
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
    Ok(result)
}

pub(crate) fn same_ownership_fingerprint(expected: &Value, current: &Value) -> bool {
    let (Some(expected), Some(current)) = (expected.as_object(), current.as_object()) else {
        return false;
    };
    if expected.len() != 5 || current.len() != 5 {
        return false;
    }
    for key in ["registrationId", "installId", "engineVersion", "rootfsSha256"] {
        let value = expected.get(key).and_then(Value::as_str).filter(|value| !value.is_empty());
        if value.is_none() || value != current.get(key).and_then(Value::as_str) {
            return false;
        }
    }
    #[cfg(windows)]
    if let (Some(expected), Some(current)) = (
        expected.get("installPath").and_then(Value::as_str),
        current.get("installPath").and_then(Value::as_str),
    ) {
        if let (Ok(expected), Ok(current)) = (native_guard::normalize(expected), native_guard::normalize(current)) {
            return expected == current;
        }
    }
    false
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

fn begin(
    mode: &str,
    operation_state: &'static str,
    expected: Value,
    start_engine: bool,
) -> Result<Value, String> {
    {
        let mut guard = state()
            .lock()
            .map_err(|_| "Runtime operation tracking is unavailable.".to_string())?;
        let command = launch(
            json!({"mode":mode,"approved":true,"expected":expected,"startEngine":start_engine}),
        )?;
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

pub fn install(token: String, approved: bool, start_engine: bool) -> Result<Value, String> {
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
    begin("install", "installing", approval.expected, start_engine)
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
    begin(mode, operation_state, expected, false)
}
pub fn start(approved: bool) -> Result<Value, String> {
    change_state("start", "stopped", "starting", approved)
}
pub fn stop(approved: bool) -> Result<Value, String> {
    change_state("stop", "running", "stopping", approved)
}

pub(crate) struct ReadGuard {
    #[cfg(windows)]
    lease: native_guard::Lease,
}
impl ReadGuard {
    #[cfg(windows)]
    pub(crate) fn discover() -> Result<(String, Value, Self), String> {
        let (owner, fingerprint, lease) = native_guard::discover()?;
        Ok((owner, fingerprint, Self { lease }))
    }
    pub(crate) fn acquire(owner: &str, fingerprint: &Value) -> Result<Self, String> {
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
    pub(crate) fn validate(&self, owner: &str, fingerprint: &Value) -> Result<(), String> {
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
    pub(super) fn normalize(value: &str) -> Result<String, String> {
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
                let mut expanded = [0u16; 32768];
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

    fn valid_guid(value: &Value) -> bool {
        let text = value.as_str().unwrap_or("");
        let text = text.strip_prefix('{').and_then(|text| text.strip_suffix('}')).unwrap_or(text);
        text.len() == 36
            && text.bytes().enumerate().all(|(index, byte)| if [8, 13, 18, 23].contains(&index) { byte == b'-' } else { byte.is_ascii_hexdigit() })
            && text.bytes().any(|byte| matches!(byte, b'1'..=b'9' | b'a'..=b'f' | b'A'..=b'F'))
    }
    pub fn discover() -> Result<(String, Value, Lease), String> {
        let registry = Registry::open(-2147483647isize as Handle, "Software\\Microsoft\\Windows\\CurrentVersion\\Lxss")?;
        for index in 0..1024 {
            let mut name = [0u16; 256];
            let mut size = name.len() as u32;
            let code = unsafe { RegEnumKeyExW(registry.0, index, name.as_mut_ptr(), &mut size, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) };
            if code == 259 { return Err(changed()); }
            if code != 0 || size as usize > name.len() { return Err(changed()); }
            let name = String::from_utf16(&name[..size as usize]).map_err(|_| changed())?;
            let entry = Registry::open(registry.0, &name)?;
            if !entry.string("DistributionName", None)?.eq_ignore_ascii_case("DockSlate") { continue; }
            let owner = entry.string("BasePath", None)?;
            let directory = Path::new(&owner);
            if directory.file_name().and_then(|name| name.to_str()) != Some("wsl") { return Err(changed()); }
            let root = directory.parent().ok_or_else(changed)?;
            let mut marker_file = pin(&root.join("ownership.json"), false)?;
            let marker = pinned_json(&mut marker_file)?;
            let fingerprint = json!({"installPath":owner,"registrationId":marker["registrationId"],"installId":marker["installId"],"engineVersion":marker["engineVersion"],"rootfsSha256":marker["rootfsSha256"]});
            let lease = Lease::acquire(&owner, &fingerprint)?;
            return Ok((owner, fingerprint, lease));
        }
        Err("WSL registration inventory exceeds its validation limit.".into())
    }
    pub struct Lease {
        _pins: [File; 5],
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
            let expected_rootfs = SCRIPT.lines().find_map(|line| line.strip_prefix("$rootfsHash = '")?.strip_suffix('\''));
            let expected_engine = SCRIPT.lines().find_map(|line| line.strip_prefix("$engineVersion = '")?.strip_suffix('\''));
            if marker["schema"] != 1
                || marker["owner"] != "DockSlate"
                || marker["distribution"] != "DockSlate"
                || marker["state"] != "installed"
                || keeper["distribution"] != "DockSlate"
                || keeper["installId"] != marker["installId"]
                || expected_rootfs.is_none() || marker["rootfsSha256"].as_str() != expected_rootfs
                || expected_engine.is_none() || marker["engineVersion"].as_str() != expected_engine
                || !valid_guid(&marker["installId"]) || !valid_guid(&marker["registrationId"])
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
            let mut program = [0u16; 32768];
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
                _pins: [
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
