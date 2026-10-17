use crate::docker::{self, Client};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

static ACTIVE: AtomicBool = AtomicBool::new(false);
static JOB: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
static APPROVALS: OnceLock<Mutex<HashMap<String, Approval>>> = OnceLock::new();
static ARCHIVES: OnceLock<Mutex<HashMap<String, Arc<Archive>>>> = OnceLock::new();
static EXPIRATION: OnceLock<Result<(), String>> = OnceLock::new();
const MAX_ARCHIVE: u64 = 2 * 1024 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(120);

struct Archive {
    path: PathBuf,
    purpose: String,
    _file: Option<File>,
    _parents: Vec<File>,
    created: Instant,
}
struct Approval {
    name: String,
    kind: String,
    engine: String,
    volume: Value,
    tree: Value,
    archive: Option<Arc<Archive>>,
    archive_info: Value,
    import_mode: String,
    import_plan: Value,
    created: Instant,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn jobs() -> &'static Mutex<Option<Value>> {
    JOB.get_or_init(|| Mutex::new(None))
}
fn approvals() -> &'static Mutex<HashMap<String, Approval>> {
    APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn archives() -> &'static Mutex<HashMap<String, Arc<Archive>>> {
    ARCHIVES.get_or_init(|| Mutex::new(HashMap::new()))
}
fn expire_handles() -> Result<(), String> {
    EXPIRATION
        .get_or_init(|| {
            thread::Builder::new()
                .name("volume-approval-expiry".into())
                .stack_size(128 * 1024)
                .spawn(|| loop {
                    thread::sleep(Duration::from_secs(5));
                    if let Ok(mut current) = approvals().lock() {
                        current.retain(|_, value| value.created.elapsed() < TTL);
                    }
                    if let Ok(mut current) = archives().lock() {
                        current
                            .retain(|_, value| value.created.elapsed() < Duration::from_secs(600));
                    }
                })
                .map(|_| ())
                .map_err(|_| "파일 선택 만료 처리를 준비할 수 없습니다.".into())
        })
        .clone()
}
pub fn is_busy() -> bool {
    ACTIVE.load(Ordering::Acquire)
}
struct BusyGuard;
impl BusyGuard {
    fn acquire() -> Result<Self, String> {
        ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "다른 볼륨 작업이 진행 중입니다.".to_string())?;
        Ok(Self)
    }
}
impl Drop for BusyGuard {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::Release);
    }
}

#[cfg(windows)]
fn token() -> Result<String, String> {
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut std::ffi::c_void,
            buffer: *mut u8,
            length: u32,
            flags: u32,
        ) -> i32;
    }
    let mut bytes = [0u8; 24];
    if unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), 24, 2) } < 0 {
        return Err("승인 토큰을 만들 수 없습니다.".into());
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
#[cfg(not(windows))]
fn token() -> Result<String, String> {
    Err("Windows에서 지원하는 기능입니다.".into())
}

fn name(value: &str) -> Result<(), String> {
    if !(2..=128).contains(&value.len())
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
    {
        return Err(
            "볼륨 이름은 영문·숫자로 시작하는 2~128자의 영문·숫자·점·밑줄·하이픈으로 입력하세요."
                .into(),
        );
    }
    Ok(())
}
fn relative(value: &str) -> Result<(), String> {
    if value.len() > 4096
        || value.starts_with('/')
        || value.contains('\\')
        || value.chars().any(char::is_control)
        || (!value.is_empty()
            && value
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".."))
    {
        return Err("볼륨 안의 상대 경로를 선택하세요. 상위 경로와 링크는 열 수 없습니다.".into());
    }
    Ok(())
}
fn fingerprint(volume: &Value) -> Value {
    let mut object = serde_json::Map::new();
    for key in [
        "Name",
        "Driver",
        "Scope",
        "Mountpoint",
        "CreatedAt",
        "Labels",
        "Options",
    ] {
        object.insert(key.into(), volume.get(key).cloned().unwrap_or(Value::Null));
    }
    Value::Object(object)
}
fn refs(containers: &[Value], volume: &str) -> Vec<Value> {
    containers.iter().filter(|container| container["Mounts"].as_array().is_some_and(|mounts| mounts.iter().any(|mount| mount["Type"] == "volume" && mount["Name"].as_str() == Some(volume)))).map(|container| {
        json!({"id":container["Id"],"name":container["Names"].as_array().and_then(|names| names.first()).and_then(Value::as_str).unwrap_or("").trim_start_matches('/'),"state":container["State"]})
    }).collect()
}
fn file_supported(volume: &Value) -> bool {
    volume["Driver"] == "local"
        && volume["Scope"] == "local"
        && (volume["Options"].is_null()
            || volume["Options"]
                .as_object()
                .is_some_and(serde_json::Map::is_empty))
}
fn row(volume: &Value, references: Vec<Value>) -> Value {
    let active = references
        .iter()
        .filter(|item| !matches!(item["state"].as_str(), Some("exited" | "created" | "dead")))
        .count();
    json!({"name":volume["Name"],"driver":volume["Driver"],"scope":volume["Scope"],"mountpoint":volume["Mountpoint"],"createdAt":volume["CreatedAt"],"labels":volume["Labels"],"options":volume["Options"],"referenceCount":references.len(),"activeReferences":active,"containers":references,"sizeBytes":volume["UsageData"]["Size"].as_i64().filter(|size| *size >= 0),"fileSupported":file_supported(volume)})
}
pub(crate) fn list_from_snapshot(usage: &Value, containers: &[Value]) -> Result<Value, String> {
    let values = usage["Volumes"].as_array().cloned().unwrap_or_default();
    if values.len() > 10000 {
        return Err("볼륨이 10,000개를 넘어 목록을 표시할 수 없습니다.".into());
    }
    let mut references = HashMap::<&str, Vec<Value>>::new();
    for container in containers {
        let mut seen = HashSet::new();
        for mount in container["Mounts"].as_array().into_iter().flatten() {
            if mount["Type"] != "volume" {
                continue;
            }
            if let Some(name) = mount["Name"].as_str().filter(|name| !name.is_empty()) {
                if seen.insert(name) {
                    references.entry(name).or_default().push(json!({"id":container["Id"],"name":container["Names"].as_array().and_then(|names| names.first()).and_then(Value::as_str).unwrap_or("").trim_start_matches('/'),"state":container["State"]}));
                }
            }
        }
    }
    let mut result: Vec<Value> = values
        .iter()
        .map(|volume| {
            row(
                volume,
                references
                    .remove(volume["Name"].as_str().unwrap_or(""))
                    .unwrap_or_default(),
            )
        })
        .collect();
    result.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    Ok(json!(result))
}
pub fn list() -> Result<Value, String> {
    let client = docker::connected()?;
    list_from_snapshot(&client.usage()?, &client.containers()?)
}
fn get(client: &Client, value: &str) -> Result<Value, String> {
    name(value)?;
    client.json("GET", &format!("/volumes/{value}"))
}
pub fn inspect(value: String) -> Result<Value, String> {
    let client = docker::connected()?;
    let volume = get(&client, &value)?;
    Ok(row(&volume, refs(&client.containers()?, &value)))
}
fn create_with(client: &Client, value: &str) -> Result<Value, String> {
    name(value)?;
    let existing = client.json("GET", "/volumes")?;
    if existing["Volumes"].as_array().is_some_and(|volumes| {
        volumes
            .iter()
            .any(|volume| volume["Name"].as_str() == Some(value))
    }) {
        return Err("같은 이름의 볼륨이 있습니다. 새 이름을 입력하세요.".into());
    }
    let id = token()?;
    let body = serde_json::to_vec(
        &json!({"Name":value,"Driver":"local","Labels":{"io.dockslate.creation":id}}),
    )
    .map_err(|_| "볼륨 생성 요청을 만들 수 없습니다.")?;
    let bytes =
        client
            .transport
            .create_volume(&client.api, &body, Duration::from_secs(30), 1024 * 1024)?;
    let result: Value =
        serde_json::from_slice(&bytes).map_err(|_| "볼륨 생성 응답을 확인할 수 없습니다.")?;
    if result["Name"].as_str() != Some(value)
        || result["Labels"]["io.dockslate.creation"].as_str() != Some(&id)
    {
        return Err("볼륨 이름이 다른 작업과 충돌했습니다. 원본은 변경하지 않았습니다. 목록을 새로고침하세요.".into());
    }
    Ok(result)
}
pub fn create(value: String) -> Result<Value, String> {
    let _busy = BusyGuard::acquire()?;
    let client = docker::connected()?;
    let created = create_with(&client, &value)?;
    Ok(json!({"name":created["Name"],"message":"볼륨을 만들었습니다."}))
}

fn request(client: &Client, operation: &str, volume: &Value) -> Value {
    json!({"operation":operation,"api":client.api,"engineId":client.identity,"name":volume["Name"],"expectedVolume":fingerprint(volume)})
}
fn helper(
    client: &Client,
    request: &Value,
    mutation: bool,
    job_id: Option<&str>,
) -> Result<Value, String> {
    let mut child = client.transport.spawn_volume_files(request, mutation)?;
    let stdout = child.stdout.take().ok_or("볼륨 도구 출력이 없습니다.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("볼륨 도구 오류 연결이 없습니다.")?;
    let id = job_id.map(String::from);
    let reader = thread::spawn(move || -> Result<Value, String> {
        let mut result = None;
        let mut consumed = 0usize;
        let mut stream = BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            let count = stream
                .by_ref()
                .take(512 * 1024)
                .read_until(b'\n', &mut line)
                .map_err(|_| "볼륨 도구 출력을 읽을 수 없습니다.")?;
            if count == 0 {
                break;
            }
            consumed += count;
            if consumed > 2 * 1024 * 1024 || line.last() != Some(&b'\n') {
                return Err("볼륨 도구 출력이 허용 크기를 넘었습니다.".into());
            }
            let value: Value = serde_json::from_slice(&line)
                .map_err(|_| "볼륨 도구 응답 형식이 올바르지 않습니다.")?;
            if value["progress"] == true {
                if let Some(id) = &id {
                    if let Ok(mut current) = jobs().lock() {
                        if let Some(job) = current
                            .as_mut()
                            .filter(|job| job["id"].as_str() == Some(id))
                        {
                            job["bytes"] = value["bytes"].clone();
                            job["entries"] = value["entries"].clone();
                        }
                    }
                }
            } else if let Some(error) = value["error"].as_str() {
                result = Some(Err(error.to_owned()));
            } else if let Some(value) = value.get("result") {
                result = Some(Ok(value.clone()));
            }
        }
        result.unwrap_or_else(|| {
            Err(
                "볼륨 파일 도구가 응답하지 않았습니다. 전용 WSL의 Python 3 지원을 확인하세요."
                    .into(),
            )
        })
    });
    let errors = thread::spawn(move || {
        let mut output = Vec::new();
        let _ = stderr.take(65536).read_to_end(&mut output);
        output
    });
    let started = Instant::now();
    let timeout = if job_id.is_some() {
        Duration::from_secs(920)
    } else {
        Duration::from_secs(50)
    };
    let success = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "볼륨 도구 상태를 확인할 수 없습니다.")?
        {
            break status.success();
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            break false;
        }
        thread::sleep(Duration::from_millis(50));
    };
    let result = reader
        .join()
        .map_err(|_| "볼륨 도구 출력 연결이 종료되었습니다.")?;
    let _ = errors.join();
    if !success && result.is_ok() {
        return Err(
            "볼륨 도구가 실패했습니다. 일부 변경이 남을 수 있으므로 상태를 다시 확인하세요.".into(),
        );
    }
    result
}
fn start_job<F>(kind: &str, value: &str, operation: F) -> Result<Value, String>
where
    F: FnOnce(&str) -> Result<Value, String> + Send + 'static,
{
    if ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("다른 볼륨 작업이 진행 중입니다.".into());
    }
    let id = match token() {
        Ok(id) => id,
        Err(error) => {
            ACTIVE.store(false, Ordering::Release);
            return Err(error);
        }
    };
    let initial = json!({"id":id,"kind":kind,"name":value,"state":"running","startedAt":now(),"bytes":0,"entries":0});
    match jobs().lock() {
        Ok(mut current) => *current = Some(initial.clone()),
        Err(_) => {
            ACTIVE.store(false, Ordering::Release);
            return Err("볼륨 작업 상태를 보관할 수 없습니다.".into());
        }
    }
    thread::spawn(move || {
        let result = operation(&id);
        if let Ok(mut current) = jobs().lock() {
            if let Some(job) = current
                .as_mut()
                .filter(|job| job["id"].as_str() == Some(&id))
            {
                job["state"] = json!(if result.is_ok() {
                    "completed"
                } else {
                    "failed"
                });
                job["completedAt"] = json!(now());
                match result {
                    Ok(value) => job["result"] = value,
                    Err(error) => {
                        job["error"] = json!(format!(
                            "{error} 작업이 중단된 경우 대상에 일부 파일이 남을 수 있습니다."
                        ))
                    }
                };
            }
        }
        ACTIVE.store(false, Ordering::Release);
    });
    Ok(initial)
}
pub fn job_status(id: String) -> Result<Value, String> {
    let current = jobs()
        .lock()
        .map_err(|_| "볼륨 작업 상태를 읽을 수 없습니다.")?;
    current
        .as_ref()
        .filter(|value| value["id"].as_str() == Some(&id))
        .cloned()
        .ok_or_else(|| "볼륨 작업을 찾을 수 없습니다.".into())
}
pub fn browse(value: String, path: String) -> Result<Value, String> {
    relative(&path)?;
    let client = docker::connected()?;
    let volume = get(&client, &value)?;
    let mut task = request(&client, "browse", &volume);
    task["path"] = json!(path);
    helper(&client, &task, false, None)
}
pub fn file_preview(value: String, path: String) -> Result<Value, String> {
    relative(&path)?;
    if path.is_empty() {
        return Err("파일을 선택하세요.".into());
    }
    let client = docker::connected()?;
    let volume = get(&client, &value)?;
    let mut task = request(&client, "file", &volume);
    task["path"] = json!(path);
    helper(&client, &task, false, None)
}
pub fn clone_volume(value: String, destination: String) -> Result<Value, String> {
    name(&value)?;
    name(&destination)?;
    if value == destination {
        return Err("원본과 다른 새 볼륨 이름을 입력하세요.".into());
    }
    let client = docker::connected()?;
    let volume = get(&client, &value)?;
    let source_refs = refs(&client.containers()?, &value);
    if source_refs
        .iter()
        .any(|item| !matches!(item["state"].as_str(), Some("exited" | "created" | "dead")))
    {
        return Err("실행 중인 컨테이너가 참조합니다. 컨테이너를 중지한 뒤 복제하세요.".into());
    }
    if !file_supported(&volume) {
        return Err("복제는 드라이버 옵션이 없는 local 볼륨에서 지원합니다.".into());
    }
    start_job("clone", &value.clone(), move |id| {
        let target = create_with(&client, &destination)?;
        if let Ok(mut current) = jobs().lock() {
            if let Some(job) = current
                .as_mut()
                .filter(|job| job["id"].as_str() == Some(id))
            {
                job["destination"] = json!(destination);
            }
        }
        let mut task = request(&client, "clone", &volume);
        task["destination"] = json!(destination);
        task["expectedDestination"] = fingerprint(&target);
        helper(&client, &task, true, Some(id))
            .map_err(|error| format!("복제 대상 볼륨 {destination}: {error}"))
    })
}

fn archive_token(value: &str, purpose: &str) -> Result<Arc<Archive>, String> {
    let mut current = archives()
        .lock()
        .map_err(|_| "파일 선택 정보를 읽을 수 없습니다.")?;
    current
        .remove(value)
        .filter(|item| item.purpose == purpose && item.created.elapsed() < Duration::from_secs(600))
        .ok_or_else(|| "파일 선택이 만료되었습니다. tar 파일을 다시 선택하세요.".into())
}
fn plain(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let metadata =
            fs::symlink_metadata(ancestor).map_err(|_| "선택한 파일 경로에 접근할 수 없습니다.")?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("링크로 연결된 파일이나 폴더는 사용할 수 없습니다.".into());
            }
        }
        if metadata.file_type().is_symlink() {
            return Err("링크로 연결된 경로는 사용할 수 없습니다.".into());
        }
    }
    Ok(())
}
fn local_file(path: &str, purpose: &str) -> Result<Archive, String> {
    let bytes = path.as_bytes();
    if bytes.len() < 4
        || bytes.len() > 32760
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
        || path[2..].contains(':')
        || path.chars().any(char::is_control)
    {
        return Err("Windows 로컬 드라이브의 tar 파일을 선택하세요.".into());
    }
    let path = PathBuf::from(path);
    if path
        .extension()
        .and_then(|part| part.to_str())
        .is_none_or(|part| !part.eq_ignore_ascii_case("tar"))
    {
        return Err("압축하지 않은 .tar 파일을 선택하세요.".into());
    }
    let parent = path
        .parent()
        .ok_or("파일의 상위 폴더를 찾을 수 없습니다.")?;
    plain(parent)?;
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetDriveTypeW(root: *const u16) -> u32;
        }
        let root: Vec<u16> = format!("{}:\\", bytes[0] as char)
            .encode_utf16()
            .chain(Some(0))
            .collect();
        if !matches!(unsafe { GetDriveTypeW(root.as_ptr()) }, 2 | 3) {
            return Err("네트워크 드라이브의 tar 파일은 사용할 수 없습니다.".into());
        }
    }
    let mut parents = Vec::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        for ancestor in parent.ancestors() {
            parents.push(
                OpenOptions::new()
                    .access_mode(0x80)
                    .share_mode(3)
                    .custom_flags(0x02200000)
                    .open(ancestor)
                    .map_err(|_| "파일의 상위 폴더를 유지할 수 없습니다.")?,
            );
        }
    }
    let file = if purpose == "import" {
        plain(&path)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1).custom_flags(0x00200000);
        }
        let file = options
            .open(&path)
            .map_err(|_| "tar 파일을 읽기 전용으로 열 수 없습니다.")?;
        let metadata = file
            .metadata()
            .map_err(|_| "tar 파일 정보를 읽을 수 없습니다.")?;
        if !metadata.is_file() || metadata.len() < 1024 || metadata.len() > MAX_ARCHIVE {
            return Err("tar 파일은 1 KB 이상 2 GB 이하의 일반 파일이어야 합니다.".into());
        }
        Some(file)
    } else {
        if path.exists() {
            return Err("기존 파일을 덮어쓰지 않습니다. 새 .tar 파일 이름을 선택하세요.".into());
        }
        None
    };
    Ok(Archive {
        path,
        purpose: purpose.into(),
        _file: file,
        _parents: parents,
        created: Instant::now(),
    })
}
pub fn pick_archive(purpose: String) -> Result<Value, String> {
    if !["import", "export"].contains(&purpose.as_str()) {
        return Err("지원하지 않는 파일 선택입니다.".into());
    }
    let selected = picker::pick(purpose == "export")?;
    let Some(path) = selected else {
        return Ok(json!({"cancelled":true}));
    };
    let archive = Arc::new(local_file(&path, &purpose)?);
    expire_handles()?;
    let id = token()?;
    let mut current = archives()
        .lock()
        .map_err(|_| "파일 선택 정보를 보관할 수 없습니다.")?;
    current.retain(|_, value| value.created.elapsed() < Duration::from_secs(600));
    if current.len() >= 8 {
        return Err("선택한 파일이 너무 많습니다. 이전 선택이 만료된 후 다시 시도하세요.".into());
    }
    current.insert(id.clone(), archive.clone());
    Ok(
        json!({"cancelled":false,"token":id,"path":archive.path.to_string_lossy(),"sizeBytes":archive._file.as_ref().and_then(|file|file.metadata().ok()).map(|meta|meta.len())}),
    )
}
pub fn export(value: String, archive_id: String) -> Result<Value, String> {
    let archive = archive_token(&archive_id, "export")?;
    let client = docker::connected()?;
    let volume = get(&client, &value)?;
    if !file_supported(&volume) {
        return Err("내보내기는 드라이버 옵션이 없는 local 볼륨에서 지원합니다.".into());
    }
    if refs(&client.containers()?, &value)
        .iter()
        .any(|item| !matches!(item["state"].as_str(), Some("exited" | "created" | "dead")))
    {
        return Err("실행 중인 컨테이너가 참조합니다. 컨테이너를 중지한 뒤 내보내세요.".into());
    }
    start_job("export", &value.clone(), move |id| {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(3).custom_flags(0x00200000);
        }
        let _file = options
            .open(&archive.path)
            .map_err(|_| "새 tar 파일을 만들 수 없습니다. 기존 파일은 덮어쓰지 않습니다.")?;
        let path = client
            .transport
            .build_path(&archive.path.to_string_lossy())?;
        let mut task = request(&client, "export", &volume);
        task["archivePath"] = json!(path);
        let result = helper(&client, &task, true, Some(id))?;
        Ok(
            json!({"message":result["message"],"path":archive.path.to_string_lossy(),"entries":result["entries"],"bytes":result["bytes"]}),
        )
    })
}

fn preview(
    kind: String,
    value: String,
    archive: Option<Arc<Archive>>,
    import_mode: String,
) -> Result<Value, String> {
    if !["delete", "empty", "import"].contains(&kind.as_str()) {
        return Err("지원하지 않는 볼륨 변경입니다.".into());
    }
    if is_busy() {
        return Err("볼륨 작업을 마친 뒤 다시 검사하세요.".into());
    }
    let client = docker::connected()?;
    let volume = get(&client, &value)?;
    let references = refs(&client.containers()?, &value);
    let mut blocked = Vec::<String>::new();
    if !references.is_empty() {
        blocked.push(
            "컨테이너가 참조하는 볼륨입니다. 중지된 컨테이너의 참조도 해제해야 합니다.".into(),
        );
    }
    let mut tree = Value::Null;
    let mut archive_info = Value::Null;
    let mut import_plan = Value::Null;
    if kind == "empty" && blocked.is_empty() {
        match helper(&client, &request(&client, "summary", &volume), false, None) {
            Ok(value) => tree = value,
            Err(error) => blocked.push(error),
        };
    }
    if kind == "import" && blocked.is_empty() {
        let selected = archive.as_ref().ok_or("가져올 tar 파일을 선택하세요.")?;
        let path = client
            .transport
            .build_path(&selected.path.to_string_lossy())?;
        let mut task = request(&client, "import_plan", &volume);
        task["archivePath"] = json!(path);
        task["mode"] = json!(import_mode);
        match helper(&client, &task, false, None) {
            Ok(value) => {
                archive_info = value["archive"].clone();
                tree = value["summary"].clone();
                import_plan = value["plan"].clone();
            }
            Err(error) => blocked.push(error),
        };
    }
    let eligible = blocked.is_empty();
    let id = if eligible { Some(token()?) } else { None };
    let expires = now() + TTL.as_millis() as u64;
    let impact = match kind.as_str() {
        "delete" => "볼륨과 저장된 파일을 삭제합니다.",
        "empty" => "볼륨은 남기고 안의 파일을 모두 삭제합니다.",
        _ if import_mode == "replace" => "기존 파일과 폴더를 모두 삭제한 뒤 tar 파일을 가져옵니다.",
        _ => "tar와 경로가 같은 파일을 덮어쓰고 폴더 속성을 적용합니다. 나머지 파일은 유지합니다.",
    };
    let result = json!({"kind":kind,"name":value,"mode":if kind=="import"{Some(&import_mode)}else{None},"importPlan":import_plan,"eligible":eligible,"token":id,"expiresAt":if eligible{Some(expires)}else{None},"references":references,"blockedReasons":blocked,"summary":tree,"archive":archive.as_ref().map(|selected|json!({"path":selected.path.to_string_lossy(),"entries":archive_info["entries"],"bytes":archive_info["bytes"]})),"impact":impact,"warnings":["DockSlate에서 이 작업을 되돌릴 수 없습니다.","실행 직전에 볼륨과 컨테이너 참조를 다시 확인합니다."]});
    if let Some(id) = id {
        expire_handles()?;
        let mut current = approvals()
            .lock()
            .map_err(|_| "승인 정보를 보관할 수 없습니다.")?;
        current.retain(|_, value| value.created.elapsed() < TTL);
        if current.len() >= 16 {
            current.clear();
        }
        current.insert(
            id,
            Approval {
                name: value,
                kind,
                engine: client.identity,
                volume: fingerprint(&volume),
                tree,
                archive,
                archive_info,
                import_mode,
                import_plan,
                created: Instant::now(),
            },
        );
    }
    Ok(result)
}
pub fn destructive_preview(kind: String, value: String) -> Result<Value, String> {
    if kind == "import" {
        return Err("가져올 tar 파일과 방식을 선택하세요.".into());
    }
    preview(kind, value, None, String::new())
}
pub fn import_preview(value: String, archive_id: String, mode: String) -> Result<Value, String> {
    if !["merge", "replace"].contains(&mode.as_str()) {
        return Err("가져오기 방식을 merge 또는 replace로 선택하세요.".into());
    }
    preview(
        "import".into(),
        value,
        Some(archive_token(&archive_id, "import")?),
        mode,
    )
}
pub fn discard_preview(id: String) -> Result<Value, String> {
    let removed = approvals()
        .lock()
        .map_err(|_| "승인 정보를 정리할 수 없습니다.")?
        .remove(&id)
        .is_some();
    Ok(json!({"discarded":removed}))
}
pub fn execute(id: String, approved: bool) -> Result<Value, String> {
    if !approved {
        return Err("볼륨 변경에는 명시적인 승인이 필요합니다.".into());
    }
    if is_busy() {
        return Err("다른 볼륨 작업이 진행 중입니다.".into());
    }
    let approval = approvals()
        .lock()
        .map_err(|_| "승인 정보를 읽을 수 없습니다.")?
        .remove(&id)
        .ok_or("승인 정보가 없거나 이미 사용했습니다. 다시 검사하세요.")?;
    if approval.created.elapsed() >= TTL {
        return Err("승인이 만료되었습니다. 다시 검사하세요.".into());
    }
    let client = docker::connected()?;
    if client.identity != approval.engine {
        return Err("Docker Engine이 변경되었습니다. 다시 검사하세요.".into());
    }
    let volume = get(&client, &approval.name)?;
    if fingerprint(&volume) != approval.volume {
        return Err("볼륨 정보가 변경되었습니다. 다시 검사하세요.".into());
    }
    if !refs(&client.containers()?, &approval.name).is_empty() {
        return Err("컨테이너가 볼륨을 참조하고 있어 작업을 중단했습니다.".into());
    }
    if approval.kind == "delete" {
        let _busy = BusyGuard::acquire()?;
        client.json("DELETE", &format!("/volumes/{}?force=false", approval.name))?;
        return Ok(
            json!({"state":"completed","message":"볼륨을 삭제했습니다.","name":approval.name}),
        );
    }
    let mut task = request(&client, &approval.kind, &volume);
    task["expectedTree"] = approval.tree;
    if let Some(archive) = &approval.archive {
        task["archivePath"] = json!(client
            .transport
            .build_path(&archive.path.to_string_lossy())?);
        task["archiveSha256"] = approval.archive_info["sha256"].clone();
        task["mode"] = json!(approval.import_mode);
        task["expectedPlan"] = approval.import_plan.clone();
    }
    start_job(&approval.kind, &approval.name.clone(), move |id| {
        let _archive_pin = approval.archive;
        helper(&client, &task, true, Some(id))
    })
}

#[cfg(not(windows))]
mod picker {
    pub fn pick(_save: bool) -> Result<Option<String>, String> {
        Err("Windows 파일 선택 창이 필요합니다.".into())
    }
}
#[cfg(windows)]
mod picker {
    use std::{ffi::c_void, thread};
    #[repr(C)]
    struct OpenFileName {
        size: u32,
        owner: *mut c_void,
        instance: *mut c_void,
        filter: *const u16,
        custom_filter: *mut u16,
        max_custom: u32,
        filter_index: u32,
        file: *mut u16,
        max_file: u32,
        file_title: *mut u16,
        max_file_title: u32,
        initial_dir: *const u16,
        title: *const u16,
        flags: u32,
        file_offset: u16,
        extension_offset: u16,
        default_extension: *const u16,
        data: isize,
        hook: *mut c_void,
        template: *const u16,
        reserved: *mut c_void,
        reserved2: u32,
        flags_ex: u32,
    }
    #[link(name = "comdlg32")]
    unsafe extern "system" {
        fn GetOpenFileNameW(info: *mut OpenFileName) -> i32;
        fn GetSaveFileNameW(info: *mut OpenFileName) -> i32;
        fn CommDlgExtendedError() -> u32;
    }
    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, flags: u32) -> i32;
        fn CoUninitialize();
    }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    pub fn pick(save: bool) -> Result<Option<String>, String> {
        thread::Builder::new()
            .name("dockslate-volume-picker".into())
            .spawn(move || {
                let result = unsafe { CoInitializeEx(std::ptr::null_mut(), 0x2 | 0x4) };
                if result < 0 {
                    return Err(format!(
                        "파일 선택 창을 초기화할 수 없습니다: 0x{:08X}",
                        result as u32
                    ));
                }
                let _apartment = Apartment;
                dialog(save)
            })
            .map_err(|_| "파일 선택 창 스레드를 시작할 수 없습니다.".to_owned())?
            .join()
            .map_err(|_| "파일 선택 창이 종료되었습니다.".to_owned())?
    }
    fn dialog(save: bool) -> Result<Option<String>, String> {
        let filter: Vec<u16> = "Tar archive (*.tar)\0*.tar\0\0".encode_utf16().collect();
        let title: Vec<u16> = (if save {
            "볼륨 내보내기 파일 선택"
        } else {
            "볼륨에 가져올 tar 파일 선택"
        })
        .encode_utf16()
        .chain(Some(0))
        .collect();
        let extension: Vec<u16> = "tar".encode_utf16().chain(Some(0)).collect();
        let mut path = vec![0u16; 32768];
        let mut info = OpenFileName {
            size: std::mem::size_of::<OpenFileName>() as u32,
            owner: std::ptr::null_mut(),
            instance: std::ptr::null_mut(),
            filter: filter.as_ptr(),
            custom_filter: std::ptr::null_mut(),
            max_custom: 0,
            filter_index: 1,
            file: path.as_mut_ptr(),
            max_file: path.len() as u32,
            file_title: std::ptr::null_mut(),
            max_file_title: 0,
            initial_dir: std::ptr::null(),
            title: title.as_ptr(),
            flags: 0x00080000
                | 0x00000800
                | 0x00000008
                | if save { 0x00000002 } else { 0x00001000 },
            file_offset: 0,
            extension_offset: 0,
            default_extension: extension.as_ptr(),
            data: 0,
            hook: std::ptr::null_mut(),
            template: std::ptr::null(),
            reserved: std::ptr::null_mut(),
            reserved2: 0,
            flags_ex: 0,
        };
        let accepted = unsafe {
            if save {
                GetSaveFileNameW(&mut info)
            } else {
                GetOpenFileNameW(&mut info)
            }
        };
        if accepted == 0 {
            let error = unsafe { CommDlgExtendedError() };
            return if error == 0 {
                Ok(None)
            } else {
                Err(format!("Windows 파일 선택 창 오류: {error}"))
            };
        }
        let length = path
            .iter()
            .position(|part| *part == 0)
            .ok_or("선택한 파일 경로가 너무 깁니다.")?;
        String::from_utf16(&path[..length])
            .map(Some)
            .map_err(|_| "선택한 파일 경로를 읽을 수 없습니다.".into())
    }
}
