use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

const LOG_LIMIT: usize = 1024 * 1024;
static ACTIVE: AtomicBool = AtomicBool::new(false);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static JOB: OnceLock<Mutex<Option<Job>>> = OnceLock::new();

struct Job {
    id: String,
    state: &'static str,
    context: String,
    dockerfile: String,
    tag: String,
    no_cache: bool,
    logs: VecDeque<u8>,
    version: u64,
    truncated: bool,
    error: Option<String>,
    image_id: Option<String>,
}
fn store() -> &'static Mutex<Option<Job>> {
    JOB.get_or_init(|| Mutex::new(None))
}
pub fn is_building() -> bool {
    ACTIVE.load(Ordering::Acquire)
}

fn valid_tag(tag: &str) -> bool {
    if tag.is_empty()
        || tag.len() > 256
        || tag.contains('@')
        || tag.contains("..")
        || !tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_.-:".contains(&b))
    {
        return false;
    }
    let (repository, version) = match tag.rsplit_once(':') {
        Some((repository, version)) if !version.contains('/') => (repository, Some(version)),
        _ => (tag, None),
    };
    if let Some(version) = version {
        if version.is_empty()
            || version.len() > 128
            || !version
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
            || !version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        {
            return false;
        }
    }
    repository.split('/').enumerate().all(|(index, segment)| {
        let segment = if index == 0 {
            if let Some((host, port)) = segment.split_once(':') {
                if host.is_empty() || port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
                    return false;
                }
                host
            } else {
                segment
            }
        } else {
            segment
        };
        !segment.is_empty()
            && segment
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && segment
                .bytes()
                .last()
                .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && segment
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b))
    })
}

fn plain(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let metadata =
            fs::symlink_metadata(ancestor).map_err(|_| "빌드 경로에 접근할 수 없습니다.")?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("링크나 다른 폴더로 연결된 빌드 경로는 사용할 수 없습니다.".into());
            }
        }
        if metadata.file_type().is_symlink() {
            return Err("링크로 연결된 빌드 경로는 사용할 수 없습니다.".into());
        }
    }
    Ok(())
}

fn pins(context: &Path, dockerfile: &Path) -> Result<Vec<File>, String> {
    let mut result = Vec::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        for path in context.ancestors() {
            result.push(
                fs::OpenOptions::new()
                    .access_mode(0x80)
                    .share_mode(3)
                    .custom_flags(0x02200000)
                    .open(path)
                    .map_err(|_| {
                        "빌드 폴더를 유지할 수 없습니다. 다른 작업을 마친 뒤 다시 시도하세요."
                    })?,
            );
        }
        result.push(
            fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .custom_flags(0x00200000)
                .open(dockerfile)
                .map_err(|_| {
                    "Dockerfile을 읽을 수 없습니다. 편집 작업을 저장한 뒤 다시 시도하세요."
                })?,
        );
    }
    Ok(result)
}

fn local_paths(context: &str, dockerfile: &str) -> Result<(PathBuf, PathBuf, Vec<File>), String> {
    let bytes = context.as_bytes();
    if context.len() > 32760
        || bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || ![b'\\', b'/'].contains(&bytes[2])
        || context[2..].contains(':')
        || context.chars().any(char::is_control)
    {
        return Err("빌드 폴더는 Windows 로컬 드라이브의 절대 경로로 입력하세요.".into());
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetDriveTypeW(root: *const u16) -> u32;
        }
        let root: Vec<_> = format!("{}:\\", bytes[0] as char)
            .encode_utf16()
            .chain(Some(0))
            .collect();
        if !matches!(unsafe { GetDriveTypeW(root.as_ptr()) }, 2 | 3) {
            return Err(
                "빌드 폴더는 로컬 디스크에서 선택하세요. 네트워크 드라이브는 사용할 수 없습니다."
                    .into(),
            );
        }
    }
    if dockerfile.is_empty()
        || dockerfile.len() > 1024
        || dockerfile.starts_with(['/', '\\'])
        || dockerfile.contains(':')
        || dockerfile.chars().any(char::is_control)
        || dockerfile
            .split(['/', '\\'])
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Dockerfile은 빌드 폴더 안의 상대 경로로 입력하세요. 상위 폴더 경로는 사용할 수 없습니다.".into());
    }
    let context = PathBuf::from(context);
    plain(&context)?;
    let context = fs::canonicalize(context).map_err(|_| "빌드 폴더를 찾을 수 없습니다.")?;
    if !context.is_dir() || context.parent().is_none() {
        return Err("드라이브 전체가 아닌 프로젝트 폴더를 선택하세요.".into());
    }
    let file = context.join(dockerfile.replace('/', "\\"));
    plain(&file)?;
    let file = fs::canonicalize(file)
        .map_err(|_| "선택한 빌드 폴더에서 Dockerfile을 찾을 수 없습니다.")?;
    if !file.is_file() || !file.starts_with(&context) {
        return Err("Dockerfile은 선택한 빌드 폴더 안의 파일이어야 합니다.".into());
    }
    let locks = pins(&context, &file)?;
    Ok((context, file, locks))
}
fn windows_path(path: &Path) -> Result<String, String> {
    let path = path
        .to_str()
        .ok_or("빌드 경로 인코딩을 확인할 수 없습니다.")?;
    Ok(path.strip_prefix("\\\\?\\").unwrap_or(path).into())
}

fn snapshot(job: &Job, version: Option<u64>) -> Value {
    let logs = if version == Some(job.version) {
        None
    } else {
        Some(String::from_utf8_lossy(&job.logs.iter().copied().collect::<Vec<_>>()).into_owned())
    };
    json!({"id":job.id,"state":job.state,"contextPath":job.context,"dockerfile":job.dockerfile,"tag":job.tag,"noCache":job.no_cache,"logs":logs,"logVersion":job.version,"truncated":job.truncated,"error":job.error,"imageId":job.image_id})
}
pub fn status(id: String, log_version: Option<u64>) -> Result<Value, String> {
    let guard = store()
        .lock()
        .map_err(|_| "빌드 상태에 접근할 수 없습니다.")?;
    let job = guard
        .as_ref()
        .filter(|job| job.id == id)
        .ok_or("현재 빌드 작업을 찾을 수 없습니다.")?;
    Ok(snapshot(job, log_version))
}
fn append(id: &str, bytes: &[u8]) {
    if let Ok(mut guard) = store().lock() {
        if let Some(job) = guard.as_mut().filter(|job| job.id == id) {
            job.logs.extend(bytes);
            if job.logs.len() > LOG_LIMIT {
                job.logs.drain(..job.logs.len() - LOG_LIMIT);
                job.truncated = true;
            }
            job.version += 1;
        }
    }
}
fn capture(
    id: String,
    mut stream: impl Read + Send + 'static,
) -> thread::JoinHandle<Result<(), String>> {
    thread::spawn(move || {
        let mut bytes = [0u8; 8192];
        loop {
            let count = stream
                .read(&mut bytes)
                .map_err(|_| "빌드 로그를 읽을 수 없습니다.")?;
            if count == 0 {
                return Ok(());
            }
            append(&id, &bytes[..count]);
        }
    })
}
fn finish(id: &str, outcome: Result<String, String>) {
    if let Ok(mut guard) = store().lock() {
        if let Some(job) = guard.as_mut().filter(|job| job.id == id) {
            match outcome {
                Ok(image) => {
                    job.state = "completed";
                    job.image_id = Some(image);
                }
                Err(error) => {
                    job.state = "failed";
                    job.error = Some(error);
                }
            }
        }
    }
    ACTIVE.store(false, Ordering::Release);
}

pub fn start(
    context_path: String,
    dockerfile: String,
    tag: String,
    no_cache: bool,
) -> Result<Value, String> {
    let tag = tag.trim();
    if !valid_tag(tag) {
        return Err("이미지 이름과 태그를 확인하세요. 예: my-app:latest".into());
    }
    let tag = if tag
        .rsplit('/')
        .next()
        .is_some_and(|name| !name.contains(':'))
    {
        format!("{tag}:latest")
    } else {
        tag.to_owned()
    };
    let (context, file, locks) = local_paths(&context_path, &dockerfile)?;
    let context = windows_path(&context)?;
    let file = windows_path(&file)?;
    if ACTIVE.swap(true, Ordering::AcqRel) {
        return Err("이미지 빌드가 이미 진행 중입니다.".into());
    }
    let id = format!(
        "{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    );
    let job = Job {
        id: id.clone(),
        state: "running",
        context: context.clone(),
        dockerfile,
        tag: tag.clone(),
        no_cache,
        logs: VecDeque::new(),
        version: 0,
        truncated: false,
        error: None,
        image_id: None,
    };
    let initial = snapshot(&job, None);
    match store().lock() {
        Ok(mut guard) => *guard = Some(job),
        Err(_) => {
            ACTIVE.store(false, Ordering::Release);
            return Err("빌드 상태를 저장할 수 없습니다.".into());
        }
    }
    let worker_id = id.clone();
    if let Err(error) = thread::Builder::new()
        .name("dockslate-image-build".into())
        .spawn(move || {
            let _locks = locks;
            let outcome = (|| {
                append(
                    &worker_id,
                    "DockSlate 엔진과 빌드 경로를 확인합니다.\n".as_bytes(),
                );
                let engine = crate::docker::prepare_image_build()?;
                let context = engine.path(&context)?;
                let dockerfile = engine.path(&file)?;
                let mut child = engine.spawn(&context, &dockerfile, &tag, no_cache)?;
                let stdout = capture(
                    worker_id.clone(),
                    child
                        .stdout
                        .take()
                        .ok_or("빌드 출력 연결에 실패했습니다.")?,
                );
                let stderr = capture(
                    worker_id.clone(),
                    child
                        .stderr
                        .take()
                        .ok_or("빌드 오류 출력 연결에 실패했습니다.")?,
                );
                let status = child
                    .wait()
                    .map_err(|error| format!("빌드 프로세스 결과를 확인할 수 없습니다: {error}"))?;
                stdout
                    .join()
                    .map_err(|_| "빌드 로그 수집에 실패했습니다.")??;
                stderr
                    .join()
                    .map_err(|_| "빌드 오류 로그 수집에 실패했습니다.")??;
                if !status.success() {
                    return Err(format!(
                        "이미지 빌드에 실패했습니다 (종료 코드 {}). 아래 로그를 확인하세요.",
                        status
                            .code()
                            .map_or_else(|| "미확인".into(), |code| code.to_string())
                    ));
                }
                engine.image_id(&tag)
            })();
            drop(_locks);
            finish(&worker_id, outcome);
        })
    {
        finish(&id, Err(format!("빌드 작업을 시작할 수 없습니다: {error}")));
        return status(id, None);
    }
    Ok(initial)
}

pub fn pick_context() -> Result<Value, String> {
    #[cfg(windows)]
    {
        picker::pick().map(|path| json!({"path":path}))
    }
    #[cfg(not(windows))]
    {
        Err("빌드 폴더 선택은 Windows에서 지원합니다.".into())
    }
}

#[cfg(windows)]
mod picker {
    use std::{ffi::c_void, thread};
    type Handle = *mut c_void;
    #[repr(C)]
    struct BrowseInfo {
        owner: Handle,
        root: *const c_void,
        display: *mut u16,
        title: *const u16,
        flags: u32,
        callback: Handle,
        parameter: isize,
        image: i32,
    }
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHBrowseForFolderW(info: *const BrowseInfo) -> Handle;
        fn SHGetPathFromIDListW(id: Handle, path: *mut u16) -> i32;
    }
    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoInitializeEx(reserved: Handle, flags: u32) -> i32;
        fn CoUninitialize();
        fn CoTaskMemFree(value: Handle);
    }
    pub fn pick() -> Result<Option<String>, String> {
        thread::spawn(|| {
            if unsafe { CoInitializeEx(std::ptr::null_mut(), 2) } < 0 {
                return Err("Windows 폴더 선택 창을 준비할 수 없습니다.".into());
            }
            let title: Vec<_> = "Dockerfile과 소스가 있는 빌드 폴더 선택"
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut display = [0u16; 260];
            let info = BrowseInfo {
                owner: std::ptr::null_mut(),
                root: std::ptr::null(),
                display: display.as_mut_ptr(),
                title: title.as_ptr(),
                flags: 0x1 | 0x40 | 0x200,
                callback: std::ptr::null_mut(),
                parameter: 0,
                image: 0,
            };
            let id = unsafe { SHBrowseForFolderW(&info) };
            let result = if id.is_null() {
                Ok(None)
            } else {
                let mut path = [0u16; 260];
                let result = if unsafe { SHGetPathFromIDListW(id, path.as_mut_ptr()) } == 0 {
                    Err("로컬 빌드 폴더를 선택하거나 경로를 직접 입력하세요.".into())
                } else {
                    Ok(Some(String::from_utf16_lossy(
                        &path[..path.iter().position(|c| *c == 0).unwrap_or(path.len())],
                    )))
                };
                unsafe { CoTaskMemFree(id) };
                result
            };
            unsafe { CoUninitialize() };
            result
        })
        .join()
        .map_err(|_| "폴더 선택 창이 종료되었습니다.".to_string())?
    }
}
