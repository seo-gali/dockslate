use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard, OnceLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const SCRIPT: &str = include_str!("../scripts/wsl-disks.ps1");
const OUTPUT_LIMIT: usize = 262_144;
const PREVIEW_LIFETIME: Duration = Duration::from_secs(120);

struct Approval {
    fingerprint: Value,
    created: Instant,
}

struct RunningCommand {
    child: Child,
    stdout: JoinHandle<Result<Vec<u8>, String>>,
    stderr: JoinHandle<Result<Vec<u8>, String>>,
}

struct Compaction {
    command: RunningCommand,
    disk_id: String,
    started_at: u64,
}

#[derive(Default)]
struct DiskState {
    approvals: BTreeMap<String, Approval>,
    active: Option<Compaction>,
    last_operation: Option<Value>,
}

static STATE: OnceLock<Mutex<DiskState>> = OnceLock::new();
static MUTATION: Mutex<()> = Mutex::new(());
static COMPACTION_ACTIVE: AtomicBool = AtomicBool::new(false);

fn state() -> &'static Mutex<DiskState> {
    STATE.get_or_init(|| Mutex::new(DiskState::default()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(windows)]
fn powershell_path() -> Result<PathBuf, String> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = vec![0u16; 32768];
    let count = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if count == 0 || count as usize >= buffer.len() {
        return Err("The Windows system directory cannot be resolved.".into());
    }
    use std::os::windows::ffi::OsStringExt;
    let directory = std::ffi::OsString::from_wide(&buffer[..count as usize]);
    let path = PathBuf::from(directory).join("WindowsPowerShell/v1.0/powershell.exe");
    if !path.is_file() {
        return Err("Windows PowerShell is unavailable. WSL disk operations are blocked.".into());
    }
    Ok(path)
}

#[cfg(not(windows))]
fn powershell_path() -> Result<PathBuf, String> {
    Err("WSL disk management is available only on Windows.".into())
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
    let status = unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), 32, 2) };
    if status < 0 {
        return Err("A secure one-time approval token cannot be generated.".into());
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(not(windows))]
fn new_token() -> Result<String, String> {
    Err("Windows cryptographic token generation is unavailable.".into())
}

fn capture(mut stream: impl Read + Send + 'static) -> JoinHandle<Result<Vec<u8>, String>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0u8; 8192];
        let mut exceeded = false;
        loop {
            let count = stream
                .read(&mut buffer)
                .map_err(|_| "Disk command output could not be read.".to_string())?;
            if count == 0 {
                break;
            }
            let remaining = OUTPUT_LIMIT.saturating_sub(output.len());
            output.extend_from_slice(&buffer[..count.min(remaining)]);
            if count > remaining {
                exceeded = true;
            }
        }
        if exceeded {
            Err("Disk command output exceeded the permitted size. The result is unverified.".into())
        } else {
            Ok(output)
        }
    })
}

fn start(request: Value) -> Result<RunningCommand, String> {
    let program = powershell_path()?;
    let modules = program
        .parent()
        .ok_or("The Windows PowerShell module path is unavailable.")?
        .join("Modules");
    let mut command = Command::new(&program);
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); & ([scriptblock]::Create([Console]::In.ReadToEnd()))",
    ]);
    command.env("DOCKSLATE_WSL_REQUEST", request.to_string());
    command.env("PSModulePath", modules);
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
        .map_err(|_| "The fixed Windows disk command could not start.".to_string())?;
    let stdout = capture(
        child
            .stdout
            .take()
            .ok_or("The disk command has no output pipe.")?,
    );
    let stderr = capture(
        child
            .stderr
            .take()
            .ok_or("The disk command has no error pipe.")?,
    );
    let mut stdin = child
        .stdin
        .take()
        .ok_or("The disk command has no input pipe.")?;
    if let Err(error) = stdin.write_all(SCRIPT.as_bytes()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "The fixed disk inspection script could not be supplied: {error}"
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
        .map_err(|_| "Disk output capture failed.".to_string())??;
    let _stderr = command
        .stderr
        .join()
        .map_err(|_| "Disk error capture failed.".to_string())??;
    let value: Value = serde_json::from_slice(&stdout).map_err(|_| {
        "The Windows disk command returned an invalid or incomplete result.".to_string()
    })?;
    if !succeeded || value.get("status").and_then(Value::as_str) == Some("failed") {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The Windows disk command failed.")
            .to_string());
    }
    Ok(value)
}

fn read_only(request: Value, timeout: Duration) -> Result<Value, String> {
    let mut command = start(request)?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = command
            .child
            .try_wait()
            .map_err(|_| "Disk inspection process status is unknown.".to_string())?
        {
            return finish(command, status.success());
        }
        if Instant::now() >= deadline {
            let _ = command.child.kill();
            let _ = command.child.wait();
            let _ = command.stdout.join();
            let _ = command.stderr.join();
            return Err("Read-only disk inspection timed out. The safety conditions remain unverified; compaction is blocked.".into());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn poll_operation() -> Result<Option<Value>, String> {
    let mut guard = state()
        .lock()
        .map_err(|_| "Disk operation state is unavailable.".to_string())?;
    if let Some(active) = guard.active.as_mut() {
        let status = active.command.child.try_wait().map_err(|_| {
            "Compaction process status is unknown. Do not restart the runtime.".to_string()
        })?;
        if let Some(status) = status
            .filter(|_| active.command.stdout.is_finished() && active.command.stderr.is_finished())
        {
            let active = guard
                .active
                .take()
                .ok_or("The active disk operation could not be retrieved.")?;
            let completed = match finish(active.command, status.success()) {
                Ok(mut result) => {
                    if let Some(object) = result.as_object_mut() {
                        object.insert("startedAt".into(), json!(active.started_at));
                        object.insert("completedAt".into(), json!(now_ms()));
                    }
                    result
                }
                Err(error) => {
                    json!({"status":"failed", "diskId":active.disk_id, "error":error, "startedAt":active.started_at, "completedAt":now_ms(), "warnings":["The before/after disk change is unverified. Inspect the disk before restarting the runtime; no backup was created."]})
                }
            };
            guard.last_operation = Some(completed);
            COMPACTION_ACTIVE.store(false, Ordering::Release);
        } else {
            return Ok(Some(
                json!({"status":"in_progress", "diskId":active.disk_id, "startedAt":active.started_at, "processId":active.command.child.id(), "warnings":["Optimization is still running. Keep the owning runtime and all WSL distributions stopped. Refresh to obtain the measured result."]}),
            ));
        }
    }
    Ok(guard.last_operation.clone())
}

fn assert_idle() -> Result<(), String> {
    let _ = poll_operation()?;
    if state()
        .lock()
        .map_err(|_| "Disk operation state is unavailable.".to_string())?
        .active
        .is_some()
    {
        return Err(
            "A disk optimization is already running. Refresh WSL Disks to check its result.".into(),
        );
    }
    Ok(())
}

pub fn inventory() -> Result<Value, String> {
    let operation = poll_operation()?;
    let mut result = read_only(json!({"mode":"inventory"}), Duration::from_secs(45))?;
    if let Some(object) = result.as_object_mut() {
        object.insert("operation".into(), operation.unwrap_or(Value::Null));
    }
    Ok(result)
}

pub fn is_compacting() -> bool {
    COMPACTION_ACTIVE.load(Ordering::Acquire)
}

pub fn runtime_mutation_guard() -> Result<MutexGuard<'static, ()>, String> {
    MUTATION
        .try_lock()
        .map_err(|_| "A WSL disk safety check or optimization is running.".to_string())
}

pub fn preview(disk_id: String) -> Result<Value, String> {
    let _mutation = MUTATION
        .try_lock()
        .map_err(|_| "Another WSL disk safety check or optimization is running.".to_string())?;
    assert_idle()?;
    if crate::runtime::is_mutating() {
        return Err("The owned runtime is changing. Disk compaction remains blocked.".into());
    }
    if disk_id.is_empty() || disk_id.len() > 64 || disk_id.contains('\0') {
        return Err("The disk ID is invalid.".into());
    }
    let mut result = read_only(
        json!({"mode":"preview", "diskId":disk_id}),
        Duration::from_secs(45),
    )?;
    let object = result
        .as_object_mut()
        .ok_or("The disk preview did not return an object.")?;
    let fingerprint = object.remove("fingerprint").unwrap_or(Value::Null);
    if object.get("eligible").and_then(Value::as_bool) == Some(true) && !fingerprint.is_null() {
        let token = new_token()?;
        let mut guard = state()
            .lock()
            .map_err(|_| "Disk approval state is unavailable.".to_string())?;
        guard
            .approvals
            .retain(|_, approval| approval.created.elapsed() < PREVIEW_LIFETIME);
        if guard.approvals.len() >= 16 {
            guard.approvals.clear();
        }
        guard.approvals.insert(
            token.clone(),
            Approval {
                fingerprint,
                created: Instant::now(),
            },
        );
        object.insert("token".into(), json!(token));
        object.insert(
            "expiresAt".into(),
            json!(now_ms() + PREVIEW_LIFETIME.as_millis() as u64),
        );
    } else {
        object.insert("token".into(), Value::Null);
        object.insert("expiresAt".into(), Value::Null);
    }
    Ok(result)
}

pub fn compact(token: String, approved: bool) -> Result<Value, String> {
    if !approved {
        return Err("Explicit approval is required to modify the selected VHDX.".into());
    }
    let _mutation = MUTATION
        .try_lock()
        .map_err(|_| "Another WSL disk safety check or optimization is running.".to_string())?;
    assert_idle()?;
    if crate::runtime::is_mutating() {
        return Err("The owned runtime is changing. Disk compaction remains blocked.".into());
    }
    let approval = state()
        .lock()
        .map_err(|_| "Disk approval state is unavailable.".to_string())?
        .approvals
        .remove(&token)
        .ok_or(
            "The disk approval token is unknown or has already been used. Create a new preview.",
        )?;
    if approval.created.elapsed() >= PREVIEW_LIFETIME {
        return Err("The disk approval expired. Create a new preview.".into());
    }
    let disk_id = approval
        .fingerprint
        .get("diskId")
        .and_then(Value::as_str)
        .ok_or("The approval has no verified disk ID.")?
        .to_string();
    if approval
        .fingerprint
        .get("backupPolicy")
        .and_then(Value::as_str)
        != Some("none")
    {
        return Err("Create a new preview for the current compaction policy.".into());
    }
    if !matches!(
        approval
            .fingerprint
            .get("compactionMethod")
            .and_then(Value::as_str),
        Some("CompactVirtualDisk" | "Optimize-VHD")
    ) || approval
        .fingerprint
        .get("virtualDiskId")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err("Create a new preview for the supported Windows disk method.".into());
    }
    COMPACTION_ACTIVE.store(true, Ordering::Release);
    let command = match start(
        json!({"mode":"compact", "diskId":disk_id, "approved":true, "expected":approval.fingerprint}),
    ) {
        Ok(command) => command,
        Err(error) => {
            COMPACTION_ACTIVE.store(false, Ordering::Release);
            return Err(error);
        }
    };
    {
        let mut guard = state()
            .lock()
            .map_err(|_| "Disk operation state is unavailable.".to_string())?;
        guard.approvals.clear();
        guard.active = Some(Compaction {
            command,
            disk_id,
            started_at: now_ms(),
        });
        guard.last_operation = None;
    }
    thread::spawn(|| {
        while COMPACTION_ACTIVE.load(Ordering::Acquire) {
            if poll_operation().is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(200));
        }
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let result = poll_operation()?.ok_or("The disk operation returned no status.")?;
        if result.get("status").and_then(Value::as_str) != Some("in_progress")
            || Instant::now() >= deadline
        {
            return Ok(result);
        }
        thread::sleep(Duration::from_millis(100));
    }
}
