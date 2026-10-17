use crate::docker::{connected, Client};
#[path = "container_archive.rs"]
mod archive;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

const FILE_SCRIPT: &str = include_str!("../scripts/container-files.sh");
const RING_LIMIT: usize = 1024 * 1024;
static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();

fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
fn checked_any_container(id: &str) -> Result<(Client, Value), String> {
    if !valid_id(id) {
        return Err("컨테이너 ID가 올바르지 않습니다.".into());
    }
    let client = connected()?;
    let container: Value = serde_json::from_slice(&client.bytes(
        "GET",
        &format!("/containers/{id}/json?size=false"),
        Duration::from_secs(10),
        2 * 1024 * 1024,
    )?)
    .map_err(|_| "컨테이너 정보를 확인하지 못했습니다.")?;
    if container["Id"].as_str() != Some(id) {
        return Err("컨테이너 ID를 확인하지 못했습니다.".into());
    }
    Ok((client, container))
}
fn checked_container(id: &str) -> Result<(Client, Value), String> {
    let (client, container) = checked_any_container(id)?;
    if container["State"]["Running"] != true || container["State"]["Paused"] == true {
        return Err(
            "실행 중인 컨테이너에서 사용할 수 있습니다. 일시정지 상태라면 먼저 계속 실행하세요."
                .into(),
        );
    }
    Ok((client, container))
}
fn container_path(path: &str) -> Result<String, String> {
    if !path.starts_with('/')
        || path.len() > 4096
        || path.contains('\0')
        || path.split('/').any(|part| matches!(part, "." | ".."))
        || path.split('/').filter(|part| !part.is_empty()).count() > 32
    {
        return Err(
            "/로 시작하는 컨테이너 경로를 입력하세요. . 또는 .. 경로는 사용할 수 없습니다.".into(),
        );
    }
    let normalized = path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    Ok(if normalized.is_empty() {
        "/".into()
    } else {
        format!("/{normalized}")
    })
}
#[cfg(windows)]
fn wsl_program() -> Result<PathBuf, String> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = vec![0u16; 32768];
    let size = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if size == 0 || size as usize >= buffer.len() {
        return Err("Windows 시스템 폴더를 확인하지 못했습니다.".into());
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..size as usize])).join("wsl.exe"))
}
#[cfg(not(windows))]
fn wsl_program() -> Result<PathBuf, String> {
    Err("컨테이너 도구는 Windows에서 지원합니다.".into())
}
fn docker_args() -> Vec<String> {
    [
        "--distribution",
        "DockSlate",
        "--user",
        "root",
        "--exec",
        "/usr/bin/env",
        "-u",
        "DOCKER_CONTEXT",
        "-u",
        "DOCKER_HOST",
        "-u",
        "DOCKER_CONFIG",
        "/usr/bin/docker",
        "--host",
        "unix:///var/run/docker.sock",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}
fn file_operation(client: &Client, id: &str, path: &str, action: &str) -> Result<Vec<u8>, String> {
    client.transport.verify_tool_start()?;
    let mut args = docker_args();
    args.extend(
        [
            "exec",
            "--interactive",
            "--",
            id,
            "/bin/sh",
            "-s",
            "--",
            action,
            path,
        ]
        .into_iter()
        .map(str::to_owned),
    );
    let result = crate::process::execute(
        &wsl_program()?,
        &args,
        Some(FILE_SCRIPT.as_bytes()),
        Duration::from_secs(12),
        1024 * 1024,
    )?;
    if !result.status.success() {
        return Err(format!(
            "컨테이너 파일을 읽지 못했습니다. /bin/sh·stat·head 지원과 파일 권한을 확인하세요. {}",
            String::from_utf8_lossy(&result.stderr)
                .chars()
                .take(1200)
                .collect::<String>()
        ));
    }
    client.transport.verify_tool_session()?;
    Ok(result.stdout)
}
pub fn files(id: String, path: String) -> Result<Value, String> {
    let path = container_path(&path)?;
    let (client, container) = checked_any_container(&id)?;
    let data = if container["State"]["Running"] == true && container["State"]["Paused"] != true {
        match file_operation(&client, &id, &path, "list") {
            Ok(data) => data,
            Err(_) => return archive_files(&client, &id, &path),
        }
    } else {
        return archive_files(&client, &id, &path);
    };
    let mut fields = data.split(|byte| *byte == 0).peekable();
    let mut entries = Vec::new();
    let mut truncated = false;
    while let Some(kind) = fields.next() {
        if kind.is_empty() {
            break;
        }
        if kind == b"truncated" {
            truncated = true;
            break;
        }
        let size = fields
            .next()
            .ok_or("컨테이너 파일 목록 형식이 올바르지 않습니다.")?;
        let modified = fields
            .next()
            .ok_or("컨테이너 파일 목록 형식이 올바르지 않습니다.")?;
        let name = fields
            .next()
            .ok_or("컨테이너 파일 목록 형식이 올바르지 않습니다.")?;
        let name = std::str::from_utf8(name)
            .map_err(|_| "UTF-8 형식이 아닌 파일 이름은 표시할 수 없습니다.")?;
        let kind = std::str::from_utf8(kind).map_err(|_| "파일 종류를 확인하지 못했습니다.")?;
        if name.is_empty()
            || name.contains('/')
            || !["directory", "file", "symlink", "other"].contains(&kind)
            || entries.len() >= 256
        {
            return Err("컨테이너 파일 목록을 확인하지 못했습니다.".into());
        }
        let numeric = |bytes: &[u8]| {
            std::str::from_utf8(bytes)
                .ok()
                .and_then(|text| text.parse::<u64>().ok())
        };
        let item_path = if path == "/" {
            format!("/{name}")
        } else {
            format!("{path}/{name}")
        };
        entries.push(json!({"name":name,"path":item_path,"kind":kind,"size":numeric(size),"modifiedAt":numeric(modified)}));
    }
    entries.sort_by(|a, b| {
        let directory = |v: &Value| v["kind"] == "directory";
        directory(b)
            .cmp(&directory(a))
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    Ok(json!({"path":path,"entries":entries,"truncated":truncated}))
}
pub fn file_preview(id: String, path: String) -> Result<Value, String> {
    let path = container_path(&path)?;
    let (client, container) = checked_any_container(&id)?;
    let data = if container["State"]["Running"] == true && container["State"]["Paused"] != true {
        match file_operation(&client, &id, &path, "preview") {
            Ok(data) => data,
            Err(_) => return archive_preview(&client, &id, &path),
        }
    } else {
        return archive_preview(&client, &id, &path);
    };
    Ok(preview_result(&path, data))
}
fn preview_result(path: &str, mut data: Vec<u8>) -> Value {
    let truncated = data.len() > 512 * 1024;
    data.truncate(512 * 1024);
    if truncated {
        if let Err(error) = std::str::from_utf8(&data) {
            if error.error_len().is_none() {
                data.truncate(error.valid_up_to());
            }
        }
    }
    let binary = data.contains(&0) || std::str::from_utf8(&data).is_err();
    json!({"path":path,"content":if binary {String::new()}else{String::from_utf8_lossy(&data).into_owned()},"binary":binary,"truncated":truncated,"bytes":data.len()})
}

fn decode_stat(data: &[u8]) -> Result<Value, String> {
    fn digit(byte: u8) -> Result<u32, String> {
        match byte {
            b'A'..=b'Z' => Ok((byte - b'A') as u32),
            b'a'..=b'z' => Ok((byte - b'a' + 26) as u32),
            b'0'..=b'9' => Ok((byte - b'0' + 52) as u32),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("컨테이너 경로 정보의 Base64 형식이 올바르지 않습니다.".into()),
        }
    }
    if data.is_empty() || data.len() > 8192 || data.len() % 4 != 0 {
        return Err("컨테이너 경로 정보 크기가 올바르지 않습니다.".into());
    }
    let mut result = Vec::with_capacity(data.len() / 4 * 3);
    for (index, block) in data.chunks_exact(4).enumerate() {
        let a = digit(block[0])?;
        let b = digit(block[1])?;
        let last = index + 1 == data.len() / 4;
        result.push(((a << 2) | (b >> 4)) as u8);
        if block[2] == b'=' {
            if !last || block[3] != b'=' || b & 15 != 0 {
                return Err("컨테이너 경로 Base64 패딩이 올바르지 않습니다.".into());
            }
            continue;
        }
        let c = digit(block[2])?;
        result.push(((b << 4) | (c >> 2)) as u8);
        if block[3] == b'=' {
            if !last || c & 3 != 0 {
                return Err("컨테이너 경로 Base64 패딩이 올바르지 않습니다.".into());
            }
            continue;
        }
        result.push(((c << 6) | digit(block[3])?) as u8);
    }
    serde_json::from_slice(&result).map_err(|_| "컨테이너 경로 정보 JSON을 읽지 못했습니다.".into())
}
fn checked_archive_path(client: &Client, id: &str, path: &str) -> Result<Value, String> {
    let mut prefix = String::new();
    let mut result = Value::Null;
    let parts = std::iter::once("")
        .chain(path.split('/').filter(|part| !part.is_empty()))
        .collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        if !part.is_empty() {
            prefix.push('/');
            prefix.push_str(part);
        }
        let target = if prefix.is_empty() { "/" } else { &prefix };
        result = decode_stat(&client.transport.archive_stat(&client.api, id, target)?)?;
        let mode = result["mode"]
            .as_u64()
            .ok_or("컨테이너 경로의 파일 종류를 확인하지 못했습니다.")?;
        if mode & 0x0800_0000 != 0
            || result["linkTarget"]
                .as_str()
                .is_some_and(|target| !target.is_empty())
        {
            return Err(
                "심볼릭 링크 경로는 따라가지 않습니다. 실제 폴더 또는 파일 경로를 선택하세요."
                    .into(),
            );
        }
        if index + 1 < parts.len() && mode & 0x8000_0000 == 0 {
            return Err("중간 경로가 컨테이너 폴더가 아닙니다.".into());
        }
    }
    Ok(result)
}
fn encode_path(path: &str) -> String {
    path.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
fn archive_bytes(client: &Client, id: &str, path: &str) -> Result<Vec<u8>, String> {
    let requested = if path == "/" { "/." } else { path };
    client.bytes("GET",&format!("/containers/{id}/archive?path={}",encode_path(requested)),Duration::from_secs(20),16*1024*1024)
        .map_err(|error|format!("컨테이너 파일 응답을 읽지 못했습니다. 폴더 전체 응답은 16MB로 제한합니다. 더 작은 하위 경로를 선택하세요. {error}"))
}
fn relative_archive_path<'a>(entry: &'a str, path: &str) -> Result<&'a str, String> {
    if path == "/" {
        return Ok(entry);
    }
    let base = path.rsplit('/').next().unwrap_or("");
    if entry == base {
        return Ok("");
    }
    entry
        .strip_prefix(base)
        .and_then(|entry| entry.strip_prefix('/'))
        .ok_or_else(|| "요청한 컨테이너 경로 밖의 TAR 항목이 포함되어 있습니다.".into())
}
fn archive_files(client: &Client, id: &str, path: &str) -> Result<Value, String> {
    let stat = checked_archive_path(client, id, path)?;
    if stat["mode"]
        .as_u64()
        .is_none_or(|mode| mode & 0x8000_0000 == 0)
    {
        return Err("선택한 컨테이너 경로가 폴더가 아닙니다.".into());
    }
    let bytes = archive_bytes(client, id, path)?;
    let records = archive::parse(&bytes)?;
    let links: HashSet<_> = records
        .iter()
        .filter(|entry| entry.kind == "symlink")
        .map(|entry| entry.path.as_str())
        .collect();
    let mut entries = HashMap::<String, Value>::new();
    let mut truncated = false;
    for record in &records {
        if record
            .path
            .char_indices()
            .filter(|(_, character)| *character == '/')
            .any(|(index, _)| links.contains(&record.path[..index]))
        {
            return Err("링크 아래의 경로가 포함된 TAR은 표시할 수 없습니다.".into());
        }
        let relative = relative_archive_path(&record.path, path)?;
        if relative.is_empty() {
            continue;
        }
        let name = relative
            .split('/')
            .next()
            .ok_or("TAR 항목 이름을 확인하지 못했습니다.")?;
        if name.is_empty() {
            return Err("TAR 항목 이름을 확인하지 못했습니다.".into());
        }
        let nested = relative.contains('/');
        if entries.contains_key(name) {
            continue;
        }
        if entries.len() >= 256 {
            truncated = true;
            continue;
        }
        let full = if path == "/" {
            format!("/{name}")
        } else {
            format!("{path}/{name}")
        };
        entries.insert(name.into(),json!({"name":name,"path":full,"kind":if nested{"directory"}else{record.kind},"size":if nested{None}else{Some(record.size)},"modifiedAt":if nested{None}else{record.modified}}));
    }
    let mut entries = entries.into_values().collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        let directory = |value: &Value| value["kind"] == "directory";
        directory(b)
            .cmp(&directory(a))
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    Ok(json!({"path":path,"entries":entries,"truncated":truncated,"method":"archive"}))
}
fn archive_preview(client: &Client, id: &str, path: &str) -> Result<Value, String> {
    let stat = checked_archive_path(client, id, path)?;
    if stat["mode"]
        .as_u64()
        .is_none_or(|mode| mode & 0x8f28_0000 != 0)
    {
        return Err(
            "일반 컨테이너 파일만 미리보기할 수 있습니다. 링크와 장치 파일은 읽지 않습니다.".into(),
        );
    }
    let bytes = archive_bytes(client, id, path)?;
    let records = archive::parse(&bytes)?;
    let base = path.rsplit('/').next().unwrap_or("");
    if records.len() != 1 || records[0].path != base || records[0].kind != "file" {
        return Err("요청한 일반 파일과 TAR 응답이 일치하지 않습니다.".into());
    }
    Ok(preview_result(
        path,
        records[0]
            .data
            .iter()
            .take(512 * 1024 + 1)
            .copied()
            .collect(),
    ))
}

struct Output {
    data: VecDeque<u8>,
    start: u64,
    end: u64,
    exited: bool,
    exit_code: Option<u32>,
}
struct Session {
    client: Client,
    container_id: String,
    console: platform::Console,
    output: Arc<Mutex<Output>>,
    touched: Instant,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.console.close();
    }
}
fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    SESSIONS.get_or_init(|| {
        thread::spawn(|| loop {
            thread::sleep(Duration::from_secs(30));
            if let Some(sessions) = SESSIONS.get() {
                if let Ok(mut sessions) = sessions.lock() {
                    sessions.retain(|_, session| {
                        session.touched.elapsed() < Duration::from_secs(15 * 60)
                    });
                }
            }
        });
        Mutex::new(HashMap::new())
    })
}
pub fn close_all() {
    if let Some(state) = SESSIONS.get() {
        if let Ok(mut sessions) = state.lock() {
            sessions.clear();
        }
    }
}
fn dimensions(cols: u16, rows: u16) -> Result<(), String> {
    if !(20..=240).contains(&cols) || !(5..=100).contains(&rows) {
        Err("터미널 크기는 20~240열, 5~100행 범위에서 사용할 수 있습니다.".into())
    } else {
        Ok(())
    }
}
pub fn terminal_open(id: String, shell: String, cols: u16, rows: u16) -> Result<Value, String> {
    dimensions(cols, rows)?;
    let shell = match shell.as_str() {
        "sh" => "/bin/sh",
        "bash" => "/bin/bash",
        _ => return Err("sh 또는 bash 셸을 선택하세요.".into()),
    };
    let (client, _) = checked_container(&id)?;
    client.transport.verify_tool_start()?;
    let mut sessions = sessions()
        .lock()
        .map_err(|_| "터미널 세션 잠금을 확인하지 못했습니다.")?;
    sessions.retain(|_, session| session.touched.elapsed() < Duration::from_secs(15 * 60));
    if sessions.len() >= 4 {
        return Err(
            "터미널은 최대 4개까지 열 수 있습니다. 기존 세션을 종료한 뒤 다시 시도하세요.".into(),
        );
    }
    let session_id = platform::random_id()?;
    let mut args = docker_args();
    args.extend(
        [
            "exec",
            "--env",
            "TERM=xterm-256color",
            "--interactive",
            "--tty",
            "--",
            &id,
            shell,
        ]
        .into_iter()
        .map(str::to_owned),
    );
    let output = Arc::new(Mutex::new(Output {
        data: VecDeque::new(),
        start: 0,
        end: 0,
        exited: false,
        exit_code: None,
    }));
    let console = platform::Console::spawn(&wsl_program()?, &args, cols, rows, output.clone())?;
    sessions.insert(
        session_id.clone(),
        Session {
            client,
            container_id: id.clone(),
            console,
            output,
            touched: Instant::now(),
        },
    );
    Ok(json!({"sessionId":session_id,"containerId":id,"cols":cols,"rows":rows}))
}
pub fn terminal_read(session_id: String, cursor: u64) -> Result<Value, String> {
    let mut sessions = sessions()
        .lock()
        .map_err(|_| "터미널 세션 잠금을 확인하지 못했습니다.")?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or("터미널 세션이 종료되었거나 만료되었습니다.")?;
    session.client.transport.verify_tool_session()?;
    session.touched = Instant::now();
    let exit_code = session.console.exit_code();
    if exit_code.is_some() {
        session.console.close();
    }
    let mut output = session
        .output
        .lock()
        .map_err(|_| "터미널 출력을 확인하지 못했습니다.")?;
    if let Some(code) = exit_code {
        output.exited = true;
        output.exit_code = Some(code);
    }
    let cursor = cursor.min(output.end);
    let truncated = cursor < output.start;
    let begin = cursor.max(output.start);
    let bytes: Vec<_> = output
        .data
        .iter()
        .skip((begin - output.start) as usize)
        .take(65536)
        .copied()
        .collect();
    Ok(
        json!({"bytes":bytes,"cursor":begin+bytes.len()as u64,"truncated":truncated,"exited":output.exited,"exitCode":output.exit_code,"containerId":session.container_id}),
    )
}
pub fn terminal_input(session_id: String, data: String) -> Result<Value, String> {
    if data.is_empty() || data.len() > 16384 {
        return Err("터미널 입력은 한 번에 16KB까지 보낼 수 있습니다.".into());
    }
    let mut sessions = sessions()
        .lock()
        .map_err(|_| "터미널 세션 잠금을 확인하지 못했습니다.")?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or("터미널 세션이 종료되었거나 만료되었습니다.")?;
    session.client.transport.verify_tool_session()?;
    session.touched = Instant::now();
    session.console.input(data.as_bytes())?;
    Ok(json!({"written":data.len()}))
}
pub fn terminal_resize(session_id: String, cols: u16, rows: u16) -> Result<Value, String> {
    dimensions(cols, rows)?;
    let mut sessions = sessions()
        .lock()
        .map_err(|_| "터미널 세션 잠금을 확인하지 못했습니다.")?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or("터미널 세션이 종료되었거나 만료되었습니다.")?;
    session.client.transport.verify_tool_session()?;
    session.touched = Instant::now();
    session.console.resize(cols, rows)?;
    Ok(json!({}))
}
pub fn terminal_close(session_id: String) -> Result<Value, String> {
    sessions()
        .lock()
        .map_err(|_| "터미널 세션 잠금을 확인하지 못했습니다.")?
        .remove(&session_id);
    Ok(json!({}))
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        ffi::c_void,
        fs::File,
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        path::Path,
    };
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Coord {
        x: i16,
        y: i16,
    }
    #[repr(C)]
    struct Startup {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        x_size: u32,
        y_size: u32,
        x_chars: u32,
        y_chars: u32,
        fill: u32,
        flags: u32,
        show: u16,
        reserved_size: u16,
        reserved2: *mut u8,
        input: Handle,
        output: Handle,
        error: Handle,
    }
    #[repr(C)]
    struct StartupEx {
        start: Startup,
        attributes: Handle,
    }
    #[repr(C)]
    struct ProcessInfo {
        process: Handle,
        thread: Handle,
        pid: u32,
        tid: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreatePipe(read: *mut Handle, write: *mut Handle, attributes: Handle, size: u32) -> i32;
        fn CreatePseudoConsole(
            size: Coord,
            input: Handle,
            output: Handle,
            flags: u32,
            console: *mut Handle,
        ) -> i32;
        fn ResizePseudoConsole(console: Handle, size: Coord) -> i32;
        fn ClosePseudoConsole(console: Handle);
        fn InitializeProcThreadAttributeList(
            list: Handle,
            count: u32,
            flags: u32,
            size: *mut usize,
        ) -> i32;
        fn UpdateProcThreadAttribute(
            list: Handle,
            flags: u32,
            attribute: usize,
            value: Handle,
            size: usize,
            previous: Handle,
            returned: *mut usize,
        ) -> i32;
        fn DeleteProcThreadAttributeList(list: Handle);
        fn CreateProcessW(
            application: *const u16,
            command: *mut u16,
            process_attributes: Handle,
            thread_attributes: Handle,
            inherit: i32,
            flags: u32,
            environment: Handle,
            directory: *const u16,
            start: *mut Startup,
            info: *mut ProcessInfo,
        ) -> i32;
        fn TerminateProcess(process: Handle, exit: u32) -> i32;
        fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    }
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptGenRandom(algorithm: Handle, buffer: *mut u8, size: u32, flags: u32) -> i32;
    }
    pub fn random_id() -> Result<String, String> {
        let mut bytes = [0u8; 24];
        if unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                2,
            )
        } < 0
        {
            return Err("터미널 세션 ID를 생성하지 못했습니다.".into());
        }
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }
    fn pipe() -> Result<(OwnedHandle, OwnedHandle), String> {
        let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
        if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null_mut(), 0) } == 0 {
            return Err("터미널 파이프를 만들지 못했습니다.".into());
        }
        Ok(unsafe {
            (
                OwnedHandle::from_raw_handle(read),
                OwnedHandle::from_raw_handle(write),
            )
        })
    }
    fn quote(value: &str) -> String {
        if !value.is_empty()
            && !value
                .chars()
                .any(|character| character.is_whitespace() || character == '"')
        {
            return value.to_owned();
        }
        let mut result = String::from("\"");
        let mut slashes = 0;
        for character in value.chars() {
            if character == '\\' {
                slashes += 1;
                continue;
            }
            if character == '"' {
                result.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
            } else {
                result.extend(std::iter::repeat_n('\\', slashes));
            }
            slashes = 0;
            result.push(character);
        }
        result.extend(std::iter::repeat_n('\\', slashes * 2));
        result.push('"');
        result
    }
    pub struct Console {
        console: usize,
        process: OwnedHandle,
        input: Option<std::sync::mpsc::SyncSender<Vec<u8>>>,
    }
    impl Console {
        pub fn spawn(
            program: &Path,
            args: &[String],
            cols: u16,
            rows: u16,
            output: Arc<Mutex<Output>>,
        ) -> Result<Self, String> {
            let (input_read, input_write) = pipe()?;
            let (output_read, output_write) = pipe()?;
            let mut console = std::ptr::null_mut();
            if unsafe {
                CreatePseudoConsole(
                    Coord {
                        x: cols as i16,
                        y: rows as i16,
                    },
                    input_read.as_raw_handle(),
                    output_write.as_raw_handle(),
                    0,
                    &mut console,
                )
            } < 0
            {
                return Err("Windows 가상 콘솔을 시작하지 못했습니다.".into());
            }
            let mut size = 0usize;
            unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
            let mut attributes = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
            if unsafe {
                InitializeProcThreadAttributeList(attributes.as_mut_ptr().cast(), 1, 0, &mut size)
            } == 0
            {
                unsafe { ClosePseudoConsole(console) };
                return Err("터미널 프로세스 설정을 준비하지 못했습니다.".into());
            }
            if unsafe {
                UpdateProcThreadAttribute(
                    attributes.as_mut_ptr().cast(),
                    0,
                    0x00020016,
                    console,
                    std::mem::size_of::<Handle>(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            } == 0
            {
                unsafe {
                    DeleteProcThreadAttributeList(attributes.as_mut_ptr().cast());
                    ClosePseudoConsole(console)
                };
                return Err("Windows 가상 콘솔을 연결하지 못했습니다.".into());
            }
            let application: Vec<_> = program.as_os_str().encode_wide().chain(Some(0)).collect();
            let command = std::iter::once(program.to_string_lossy().into_owned())
                .chain(args.iter().cloned())
                .map(|arg| quote(&arg))
                .collect::<Vec<_>>()
                .join(" ");
            let mut command: Vec<_> = command.encode_utf16().chain(Some(0)).collect();
            let mut startup: StartupEx = unsafe { std::mem::zeroed() };
            startup.start.cb = std::mem::size_of::<StartupEx>() as u32;
            startup.attributes = attributes.as_mut_ptr().cast();
            let mut info: ProcessInfo = unsafe { std::mem::zeroed() };
            let created = unsafe {
                CreateProcessW(
                    application.as_ptr(),
                    command.as_mut_ptr(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    0,
                    0x00080000,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    &mut startup.start,
                    &mut info,
                )
            };
            let create_error = (created == 0).then(std::io::Error::last_os_error);
            drop(input_read);
            drop(output_write);
            unsafe { DeleteProcThreadAttributeList(attributes.as_mut_ptr().cast()) };
            if created == 0 {
                unsafe { ClosePseudoConsole(console) };
                return Err(format!(
                    "컨테이너 터미널을 시작하지 못했습니다: {}",
                    create_error.expect("failed process creation")
                ));
            }
            let process = unsafe { OwnedHandle::from_raw_handle(info.process) };
            drop(unsafe { OwnedHandle::from_raw_handle(info.thread) });
            let process_id = info.process as usize;
            thread::spawn(move || {
                let mut stream = File::from(output_read);
                let mut buffer = [0u8; 8192];
                loop {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => {
                            if let Ok(mut output) = output.lock() {
                                for byte in &buffer[..count] {
                                    output.data.push_back(*byte);
                                    output.end += 1;
                                    if output.data.len() > RING_LIMIT {
                                        output.data.pop_front();
                                        output.start += 1;
                                    }
                                }
                            }
                        }
                    }
                }
                if let Ok(mut output) = output.lock() {
                    output.exited = true;
                    let mut code = 259;
                    if unsafe { GetExitCodeProcess(process_id as Handle, &mut code) } != 0
                        && code != 259
                    {
                        output.exit_code = Some(code);
                    }
                }
            });
            let (input_sender, input_receiver) = std::sync::mpsc::sync_channel::<Vec<u8>>(16);
            thread::spawn(move || {
                let mut input = File::from(input_write);
                while let Ok(data) = input_receiver.recv() {
                    if input.write_all(&data).is_err() {
                        break;
                    }
                }
            });
            Ok(Self {
                console: console as usize,
                process,
                input: Some(input_sender),
            })
        }
        pub fn exit_code(&self) -> Option<u32> {
            let mut code = 259;
            if unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) } != 0
                && code != 259
            {
                Some(code)
            } else {
                None
            }
        }
        pub fn input(&mut self, data: &[u8]) -> Result<(), String> {
            self.input
                .as_ref()
                .ok_or("터미널이 종료되었습니다.")?
                .try_send(data.to_vec())
                .map_err(|_| "터미널 입력을 처리 중입니다. 잠시 뒤 다시 입력하세요.".into())
        }
        pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
            if self.console == 0
                || unsafe {
                    ResizePseudoConsole(
                        self.console as Handle,
                        Coord {
                            x: cols as i16,
                            y: rows as i16,
                        },
                    )
                } < 0
            {
                Err("터미널 크기를 변경하지 못했습니다.".into())
            } else {
                Ok(())
            }
        }
        pub fn close(&mut self) {
            if self.console != 0 {
                self.input.take();
                unsafe {
                    TerminateProcess(self.process.as_raw_handle(), 0);
                    ClosePseudoConsole(self.console as Handle);
                    WaitForSingleObject(self.process.as_raw_handle(), 1000)
                };
                self.console = 0;
            }
        }
    }
}
#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn random_id() -> Result<String, String> {
        Err("터미널은 Windows에서 지원합니다.".into())
    }
    pub struct Console;
    impl Console {
        pub fn spawn(
            _: &std::path::Path,
            _: &[String],
            _: u16,
            _: u16,
            _: Arc<Mutex<Output>>,
        ) -> Result<Self, String> {
            Err("터미널은 Windows에서 지원합니다.".into())
        }
        pub fn input(&mut self, _: &[u8]) -> Result<(), String> {
            Err("터미널을 사용할 수 없습니다.".into())
        }
        pub fn exit_code(&self) -> Option<u32> {
            None
        }
        pub fn resize(&self, _: u16, _: u16) -> Result<(), String> {
            Err("터미널을 사용할 수 없습니다.".into())
        }
        pub fn close(&mut self) {}
    }
}
