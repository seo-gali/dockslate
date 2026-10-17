use serde::Deserialize;
use serde_json::{json, Value};
#[path = "build_archive.rs"]
mod archive;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const JSON_LIMIT: usize = 2 * 1024 * 1024;
const ARCHIVE_LIMIT: usize = 64 * 1024 * 1024;
static ACTIVE: AtomicBool = AtomicBool::new(false);
static NEXT: AtomicU64 = AtomicU64::new(1);
static TRANSFER: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
static VERSION: OnceLock<Mutex<Option<(String, String)>>> = OnceLock::new();
static MUTATION: Mutex<()> = Mutex::new(());
#[derive(Clone)]
struct BuilderSelection {
    engine: String,
    name: String,
    fingerprint: String,
}
static SELECTION: Mutex<Option<BuilderSelection>> = Mutex::new(None);
#[derive(Default)]
struct LibraryCache {
    manifest: Vec<(PathBuf, u64, Option<SystemTime>)>,
    records: Arc<Vec<Value>>,
}
static LIBRARY_CACHE: OnceLock<Mutex<LibraryCache>> = OnceLock::new();

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn is_busy() -> bool {
    ACTIVE.load(Ordering::Acquire)
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}
fn valid_reference(reference: &str) -> bool {
    !reference.is_empty() && reference.len() <= 256 && reference.split('/').all(valid_name)
}
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).into()).collect()
}
fn output(
    client: &crate::docker::Client,
    values: &[String],
    mutation: bool,
    timeout: u64,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let result = client.transport.buildx_command(
        values,
        mutation,
        None,
        Duration::from_secs(timeout),
        limit,
    )?;
    if !result.status.success() {
        let message = String::from_utf8_lossy(&result.stderr);
        return Err(message
            .chars()
            .take(8192)
            .collect::<String>()
            .trim()
            .to_owned());
    }
    Ok(result.stdout)
}
fn json_values(bytes: &[u8]) -> Result<Vec<Value>, String> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new());
    }
    if let Ok(Value::Array(values)) = serde_json::from_slice(bytes) {
        return Ok(values);
    }
    serde_json::Deserializer::from_slice(bytes)
        .into_iter::<Value>()
        .map(|value| value.map_err(|_| "빌드 조회 응답을 읽을 수 없습니다.".into()))
        .collect()
}
fn builders(client: &crate::docker::Client) -> Result<Vec<Value>, String> {
    let result = output(
        client,
        &args(&["ls", "--format", "json", "--no-trunc", "--timeout", "3s"]),
        false,
        12,
        JSON_LIMIT,
    )?;
    let values = json_values(&result)?;
    Ok(values.into_iter().filter_map(|value| {
        let name = text(&value, "Name"); if !valid_name(name) { return None; }
        let nodes = value["Nodes"].as_array().cloned().unwrap_or_default();
        let mut platforms = Vec::<String>::new();
        let normalized: Vec<_> = nodes.iter().map(|node| {
            let node_platforms = node["Platforms"].as_array().cloned().unwrap_or_default().iter().filter_map(|platform| {
                if let Some(platform) = platform.as_str() { Some(platform.to_owned()) }
                else { let os = text(platform, "os"); let arch = text(platform, "architecture"); if os.is_empty() || arch.is_empty() { None } else { Some(format!("{os}/{arch}{}", platform["variant"].as_str().filter(|value| !value.is_empty()).map(|value| format!("/{value}")).unwrap_or_default())) } }
            }).collect::<Vec<_>>();
            for platform in &node_platforms { if !platforms.contains(platform) { platforms.push(platform.clone()); } }
            json!({"name":node["Name"],"endpoint":node["Endpoint"],"status":node["Status"],"version":node["Version"],"platforms":node_platforms,"error":node["Err"]})
        }).collect();
        Some(json!({"name":name,"driver":value["Driver"],"current":value["Current"].as_bool().unwrap_or(false),"nodes":normalized,"platforms":platforms,"error":value["Err"],"lastActivity":value["LastActivity"]}))
    }).collect())
}
fn builder_fingerprint(builder: &Value) -> Result<String, String> {
    let mut nodes: Vec<_> = builder["nodes"]
        .as_array()
        .ok_or("빌더 노드 정보를 확인하지 못했습니다.")?
        .iter()
        .map(|node| json!({"name":node["name"],"endpoint":node["endpoint"]}))
        .collect();
    nodes.sort_by(|left, right| text(left, "name").cmp(text(right, "name")));
    let bytes = serde_json::to_vec(
        &json!({"name":builder["name"],"driver":builder["driver"],"nodes":nodes}),
    )
    .map_err(|_| "빌더 식별 정보를 구성할 수 없습니다.")?;
    archive::sha256(&bytes)
}
fn local_default(builder: &Value) -> bool {
    builder["name"] == "default"
        && builder["driver"] == "docker"
        && builder["nodes"].as_array().is_some_and(|nodes| {
            nodes.len() == 1
                && matches!(
                    nodes[0]["endpoint"].as_str(),
                    Some("default" | "unix:///var/run/docker.sock")
                )
        })
}
fn selected(client: &crate::docker::Client, values: &[Value]) -> Result<String, String> {
    let mut selection = SELECTION
        .lock()
        .map_err(|_| "빌더 선택 상태에 접근할 수 없습니다.")?;
    if let Some(previous) = selection
        .as_ref()
        .filter(|value| value.engine == client.identity)
    {
        let current = values
            .iter()
            .find(|builder| builder["name"] == previous.name)
            .ok_or("선택한 빌더가 삭제되었습니다. 빌더 목록에서 다시 선택하세요.")?;
        if builder_fingerprint(current)? != previous.fingerprint {
            return Err("선택한 빌더의 노드나 주소가 변경되었습니다. 빌더 목록에서 대상을 확인하고 다시 선택하세요.".into());
        }
        return Ok(previous.name.clone());
    }
    let builder = values.iter().find(|builder| local_default(builder)).ok_or("DockSlate 엔진의 로컬 기본 빌더를 확인하지 못했습니다. 빌더 목록에서 사용할 대상을 직접 선택하세요.")?;
    let value = BuilderSelection {
        engine: client.identity.clone(),
        name: text(builder, "name").into(),
        fingerprint: builder_fingerprint(builder)?,
    };
    let name = value.name.clone();
    *selection = Some(value);
    Ok(name)
}
pub fn selected_builder() -> Result<String, String> {
    let client = crate::docker::connected()?;
    selected(&client, &builders(&client)?)
}
fn require_builder(client: &crate::docker::Client, name: &str) -> Result<Value, String> {
    if !valid_name(name) {
        return Err("빌더 이름을 확인하세요.".into());
    }
    builders(client)?
        .into_iter()
        .find(|builder| builder["name"] == name)
        .ok_or("선택한 빌더가 없습니다. 전체 새로고침 후 다시 선택하세요.".into())
}
fn cli_reference(
    client: &crate::docker::Client,
    builder: &str,
    reference: &str,
) -> Result<String, String> {
    if !valid_reference(reference) {
        return Err("빌드 기록 ID를 확인하세요.".into());
    }
    let declared = require_builder(client, builder)?;
    let parts: Vec<_> = reference.split('/').collect();
    match parts.as_slice() {
        [id] => Ok((*id).to_owned()),
        [owner, node, id]
            if *owner == builder
                && declared["nodes"].as_array().is_some_and(|nodes| {
                    nodes
                        .iter()
                        .any(|entry| entry["name"].as_str() == Some(*node))
                }) =>
        {
            Ok((*id).to_owned())
        }
        _ => Err(
            "빌드 기록의 빌더와 노드가 선택한 빌더에 속하지 않습니다. 목록을 다시 조회하세요."
                .into(),
        ),
    }
}
fn history(client: &crate::docker::Client, builder: &str) -> Value {
    let outcome = output(
        client,
        &args(&[
            "history",
            "ls",
            "--builder",
            builder,
            "--format",
            "json",
            "--no-trunc",
        ]),
        false,
        15,
        JSON_LIMIT,
    )
    .and_then(|bytes| json_values(&bytes));
    match outcome {
        Ok(values) => {
            let truncated = values.len() > 200;
            let records: Vec<_> = values.into_iter().take(200).map(|value| json!({
                "ref":value.get("ref").or_else(|| value.get("ID")).or_else(|| value.get("Ref")),
                "name":value.get("name").or_else(|| value.get("Name")),"status":value.get("status").or_else(|| value.get("Status")),
                "createdAt":value.get("created_at").or_else(|| value.get("CreatedAt")),"completedAt":value.get("completed_at").or_else(|| value.get("CompletedAt")),
                "totalSteps":value.get("total_steps").or_else(|| value.get("NumTotalSteps")),"cachedSteps":value.get("cached_steps").or_else(|| value.get("NumCachedSteps")),
            })).collect();
            json!({"builder":builder,"state":"ready","records":records,"message":if truncated { "최근 200개 기록을 표시합니다." } else { "" }})
        }
        Err(error) => {
            json!({"builder":builder,"state":if error.contains("Unimplemented") || error.contains("not supported") || error.contains("not implemented") { "unsupported" } else { "error" },"records":[],"message":error})
        }
    }
}
fn plain(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let metadata =
            fs::symlink_metadata(ancestor).map_err(|_| "파일 경로에 접근할 수 없습니다.")?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("연결된 폴더나 파일은 사용할 수 없습니다.".into());
            }
        }
        if metadata.file_type().is_symlink() {
            return Err("심볼릭 링크 파일은 사용할 수 없습니다.".into());
        }
    }
    Ok(())
}
fn local_path(value: &str, save: bool) -> Result<PathBuf, String> {
    let bytes = value.as_bytes();
    if bytes.len() < 4
        || value.len() > 32760
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || ![b'\\', b'/'].contains(&bytes[2])
        || value[2..].contains(':')
        || value.chars().any(char::is_control)
        || value.split(['/', '\\']).any(|part| part == "..")
    {
        return Err("Windows 로컬 드라이브의 파일 경로를 입력하세요.".into());
    }
    let path = PathBuf::from(value);
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("dockerbuild"))
    {
        return Err(".dockerbuild 확장자의 빌드 기록 파일을 선택하세요.".into());
    }
    let parent = path.parent().ok_or("파일 폴더를 확인할 수 없습니다.")?;
    plain(parent)?;
    if save {
        if path.exists() {
            return Err("같은 이름의 파일이 있습니다. 새 파일 이름을 선택하세요.".into());
        }
    } else {
        plain(&path)?;
        let metadata = fs::metadata(&path).map_err(|_| "빌드 기록 파일을 찾을 수 없습니다.")?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > ARCHIVE_LIMIT as u64 {
            return Err("빌드 기록은 64MB 이하의 일반 파일이어야 합니다.".into());
        }
    }
    Ok(path)
}
fn library() -> Result<PathBuf, String> {
    let root = std::env::var_os("LOCALAPPDATA").ok_or("앱 데이터 폴더를 확인할 수 없습니다.")?;
    let root = PathBuf::from(root);
    plain(&root)?;
    let mut directory = root;
    for name in ["DockSlate", "build-records"] {
        directory.push(name);
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("빌드 기록 보관 폴더를 만들 수 없습니다.".into()),
        }
        plain(&directory)?;
        if !directory.is_dir() {
            return Err("빌드 기록 보관 경로가 폴더가 아닙니다.".into());
        }
    }
    Ok(directory)
}
fn read_metadata(path: &Path) -> Result<Vec<u8>, String> {
    plain(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x00200000);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "보관 기록을 읽기 전용으로 열 수 없습니다.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "보관 기록 파일 정보를 확인할 수 없습니다.")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("연결된 보관 기록 파일은 사용할 수 없습니다.".into());
        }
    }
    if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
        return Err("보관 기록이 16MB 제한을 초과했습니다.".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "보관 기록을 읽을 수 없습니다.")?;
    if bytes.len() > 16 * 1024 * 1024 || bytes.len() as u64 != metadata.len() {
        return Err("보관 기록 크기가 변경되었거나 16MB 제한을 초과했습니다.".into());
    }
    Ok(bytes)
}
fn imported() -> Result<Arc<Vec<Value>>, String> {
    let directory = library()?;
    let mut manifest = Vec::new();
    let mut total_bytes = 0u64;
    for (count, item) in fs::read_dir(directory)
        .map_err(|_| "보관한 빌드 기록을 읽을 수 없습니다.")?
        .enumerate()
    {
        if count >= 1000 {
            return Err("보관 폴더의 파일 개수가 제한을 초과했습니다.".into());
        }
        let path = item
            .map_err(|_| "빌드 기록 파일을 확인할 수 없습니다.")?
            .path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        plain(&path)?;
        let metadata = fs::metadata(&path).map_err(|_| "보관 기록 정보를 확인할 수 없습니다.")?;
        total_bytes += metadata.len();
        if !metadata.is_file()
            || metadata.len() > 16 * 1024 * 1024
            || total_bytes > 32 * 1024 * 1024
        {
            return Err("보관 기록이 크기 제한을 초과했습니다.".into());
        }
        manifest.push((path, metadata.len(), metadata.modified().ok()));
    }
    manifest.sort_by(|left, right| left.0.cmp(&right.0));
    let mut cache = LIBRARY_CACHE
        .get_or_init(|| Mutex::new(LibraryCache::default()))
        .lock()
        .map_err(|_| "보관 기록 캐시에 접근할 수 없습니다.")?;
    if cache.manifest == manifest {
        return Ok(cache.records.clone());
    }
    let mut records = Vec::new();
    for (path, _, _) in &manifest {
        let bytes = read_metadata(path)?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "보관 기록 형식을 확인할 수 없습니다.")?;
        if let Some(values) = value["records"].as_array() {
            records.extend(values.iter().cloned());
        }
        if records.len() > 200 {
            return Err("보관 기록이 200개 제한을 초과했습니다.".into());
        }
    }
    cache.manifest = manifest;
    cache.records = Arc::new(records);
    Ok(cache.records.clone())
}
fn brief(record: &Value) -> Value {
    Value::Object(
        record
            .as_object()
            .map(|object| {
                object
                    .iter()
                    .filter(|(key, _)| !["details", "logs"].contains(&key.as_str()))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect()
            })
            .unwrap_or_default(),
    )
}
pub fn snapshot() -> Result<Value, String> {
    let records: Vec<_> = imported()?.iter().map(brief).collect();
    let transfer = TRANSFER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "기록 전송 상태를 확인할 수 없습니다.")?
        .clone();
    let client = match crate::docker::connected() {
        Ok(client) => client,
        Err(message) => {
            return Ok(
                json!({"version":"","selectedBuilder":"","builders":[],"history":{"builder":"","state":"unavailable","message":message,"records":[]},"imported":records,"transfer":transfer}),
            )
        }
    };
    let mut values = builders(&client)?;
    let selection = selected(&client, &values);
    let selection_error = selection.as_ref().err().cloned();
    let builder = selection.unwrap_or_default();
    for value in &mut values {
        value["cliCurrent"] = value["current"].clone();
        value["current"] = json!(value["name"] == builder);
    }
    let version = {
        let mut cache = VERSION
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "Buildx 버전 캐시에 접근할 수 없습니다.")?;
        if cache
            .as_ref()
            .is_none_or(|(identity, _)| identity != &client.identity)
        {
            let version =
                String::from_utf8_lossy(&output(&client, &args(&["version"]), false, 10, 65536)?)
                    .trim()
                    .to_owned();
            *cache = Some((client.identity.clone(), version));
        }
        cache
            .as_ref()
            .map(|(_, version)| version.clone())
            .unwrap_or_default()
    };
    Ok(
        json!({"version":version,"selectedBuilder":builder,"selectionError":selection_error,"builders":values,"history":if builder.is_empty(){json!({"builder":"","state":"error","records":[],"message":selection_error})}else{history(&client,&builder)},"imported":records,"transfer":transfer}),
    )
}
pub fn history_list(builder: String) -> Result<Value, String> {
    let client = crate::docker::connected()?;
    require_builder(&client, &builder)?;
    Ok(history(&client, &builder))
}
pub fn builder_inspect(name: String) -> Result<Value, String> {
    let client = crate::docker::connected()?;
    require_builder(&client, &name)?;
    let bytes = output(
        &client,
        &args(&["inspect", "--timeout", "5s", &name]),
        false,
        12,
        JSON_LIMIT,
    )?;
    Ok(json!({"output":String::from_utf8_lossy(&bytes)}))
}
pub fn history_detail(
    builder: String,
    reference: String,
    imported_id: Option<String>,
) -> Result<Value, String> {
    if let Some(id) = imported_id {
        return imported()?
            .iter()
            .find(|record| record["id"] == id)
            .cloned()
            .ok_or("보관한 빌드 기록을 찾을 수 없습니다.".into());
    }
    let client = crate::docker::connected()?;
    let reference = cli_reference(&client, &builder, &reference)?;
    let details: Value = serde_json::from_slice(&output(
        &client,
        &args(&[
            "history",
            "inspect",
            "--builder",
            &builder,
            "--format",
            "json",
            &reference,
        ]),
        false,
        20,
        JSON_LIMIT,
    )?)
    .map_err(|_| "빌드 상세 응답을 읽을 수 없습니다.")?;
    let result = client.transport.buildx_command(
        &args(&[
            "history",
            "logs",
            "--builder",
            &builder,
            "--progress",
            "plain",
            &reference,
        ]),
        false,
        None,
        Duration::from_secs(20),
        JSON_LIMIT,
    )?;
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr)
            .chars()
            .take(8192)
            .collect());
    }
    let mut logs = result.stdout;
    logs.extend(result.stderr);
    let truncated = logs.len() > 1024 * 1024;
    if truncated {
        logs.drain(..logs.len() - 1024 * 1024);
    }
    Ok(
        json!({"details":details,"logs":String::from_utf8_lossy(&logs),"truncated":truncated,"source":"BuildKit"}),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuilderRequest {
    action: String,
    name: String,
    driver: Option<String>,
    endpoint: Option<String>,
    platforms: Option<Vec<String>>,
    node: Option<String>,
}
fn platforms(values: &[String]) -> Result<String, String> {
    if values.len() > 16
        || values.iter().any(|value| {
            value.len() > 128
                || !(2..=3).contains(&value.split('/').count())
                || value.split('/').any(|part| {
                    part.is_empty()
                        || !part
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
                })
        })
    {
        return Err("플랫폼은 linux/amd64 또는 linux/arm64 형식으로 최대 16개 입력하세요.".into());
    }
    Ok(values.join(","))
}
fn remote_endpoint(value: &str) -> bool {
    if value.len() > 512
        || value.chars().any(char::is_control)
        || value.contains(['?', '#', '\\'])
        || value.split('/').any(|part| part == "..")
    {
        return false;
    }
    if let Some(address) = value.strip_prefix("tcp://") {
        if let Some((host, port)) = address.rsplit_once(':') {
            return !host.is_empty()
                && host
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-:[]".contains(&byte))
                && port.parse::<u16>().is_ok_and(|port| port > 0);
        }
    }
    if let Some(path) = value.strip_prefix("unix://") {
        return (path.starts_with("/run/") || path.starts_with("/var/run/"))
            && path
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"/_.-".contains(&byte));
    }
    false
}
pub fn builder_change(request: BuilderRequest, approved: bool) -> Result<Value, String> {
    if !approved {
        return Err("대상과 영향을 확인한 뒤 빌더 변경을 승인하세요.".into());
    }
    if crate::image_build::is_building() || is_busy() {
        return Err("빌드나 기록 전송을 마친 뒤 빌더를 변경하세요.".into());
    }
    let _lock = MUTATION
        .lock()
        .map_err(|_| "빌더 변경 상태에 접근할 수 없습니다.")?;
    if !valid_name(&request.name) {
        return Err("빌더 이름을 확인하세요.".into());
    }
    let client = crate::docker::connected()?;
    let existing = builders(&client)?;
    let found = existing
        .iter()
        .find(|builder| builder["name"] == request.name);
    let platform = platforms(request.platforms.as_deref().unwrap_or_default())?;
    let command = match request.action.as_str() {
        "use" => {
            let builder = found.ok_or("선택한 빌더가 없습니다.")?;
            *SELECTION
                .lock()
                .map_err(|_| "빌더 선택 상태에 접근할 수 없습니다.")? = Some(BuilderSelection {
                engine: client.identity.clone(),
                name: request.name.clone(),
                fingerprint: builder_fingerprint(builder)?,
            });
            return Ok(
                json!({"message":format!("DockSlate에서 {} 빌더를 선택했습니다. 앱을 다시 시작하면 로컬 기본 빌더를 사용합니다.",request.name),"selectedBuilder":request.name}),
            );
        }
        "remove" => {
            if request.name == "default"
                || found.is_none_or(|builder| builder["driver"] == "docker")
            {
                return Err("기본 Docker 빌더는 삭제할 수 없습니다.".into());
            }
            args(&["rm", "--keep-daemon", "--keep-state", &request.name])
        }
        "create" => {
            if found.is_some() || request.name == "default" {
                return Err("같은 이름의 빌더가 있습니다. 새 이름을 사용하세요.".into());
            }
            let driver = request.driver.as_deref().unwrap_or("docker-container");
            let endpoint = match driver { "docker-container" => "unix:///var/run/docker.sock", "remote" => request.endpoint.as_deref().filter(|value| remote_endpoint(value)).ok_or("원격 BuildKit 주소는 tcp://호스트:포트 또는 unix:///run/소켓 형식을 사용하세요.")?, _ => return Err("docker-container 또는 remote 드라이버를 선택하세요.".into()) };
            let mut command = args(&["create", "--name", &request.name, "--driver", driver]);
            if driver == "docker-container" {
                command.extend(args(&["--driver-opt", "default-load=true"]));
            }
            if !platform.is_empty() {
                command.extend(args(&["--platform", &platform]));
            }
            command.push(endpoint.into());
            command
        }
        "update" => {
            let builder = found.ok_or("선택한 빌더가 없습니다.")?;
            let driver = text(builder, "driver");
            if driver == "docker" || platform.is_empty() {
                return Err("사용자 빌더의 노드와 플랫폼을 선택하세요.".into());
            }
            let node_name = request
                .node
                .as_deref()
                .ok_or("변경할 빌더 노드를 선택하세요.")?;
            let node = builder["nodes"]
                .as_array()
                .and_then(|nodes| nodes.iter().find(|node| node["name"] == node_name))
                .ok_or("선택한 노드를 확인하지 못했습니다.")?;
            args(&[
                "create",
                "--name",
                &request.name,
                "--node",
                node_name,
                "--driver",
                driver,
                "--platform",
                &platform,
                text(node, "endpoint"),
            ])
        }
        _ => return Err("지원하지 않는 빌더 작업입니다.".into()),
    };
    let bytes = output(&client, &command, true, 30, JSON_LIMIT)?;
    Ok(
        json!({"message":format!("빌더 {} 작업을 완료했습니다.", request.action),"output":String::from_utf8_lossy(&bytes)}),
    )
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferRequest {
    kind: String,
    path: String,
    builder: Option<String>,
    reference: Option<String>,
    imported_id: Option<String>,
}
pub fn transfer_status(id: String) -> Result<Value, String> {
    TRANSFER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "기록 전송 상태에 접근할 수 없습니다.")?
        .as_ref()
        .filter(|job| job["id"] == id)
        .cloned()
        .ok_or("기록 전송 작업을 찾을 수 없습니다.".into())
}
fn transfer_run(request: &TransferRequest) -> Result<Value, String> {
    if request.kind == "import" {
        let path = local_path(&request.path, false)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1);
        }
        let mut source = options
            .open(&path)
            .map_err(|_| "가져올 파일을 읽기 전용으로 열 수 없습니다.")?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut source)
            .take((ARCHIVE_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "빌드 기록 파일을 읽을 수 없습니다.")?;
        let mut catalog = archive::parse(&bytes)?;
        let digest = text(&catalog, "archiveSha256").to_owned();
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("보관 파일 식별 정보를 확인할 수 없습니다.".into());
        }
        let directory = library()?;
        let archive = directory.join(format!("{digest}.dockerbuild"));
        let index = directory.join(format!("{digest}.json"));
        if index.exists() {
            return Err("이미 가져온 빌드 기록 파일입니다.".into());
        }
        let existing = imported()?.len();
        let records = catalog["records"]
            .as_array_mut()
            .ok_or("빌드 기록 목록이 없습니다.")?;
        if records.is_empty() || existing + records.len() > 200 {
            return Err("보관 기록은 최대 200개까지 가져올 수 있습니다.".into());
        }
        for (position, record) in records.iter_mut().enumerate() {
            record["id"] = json!(format!("{digest}:{position}"));
            record["archiveId"] = json!(digest);
            record["source"] = json!("가져온 파일");
            record["importedAt"] = json!(now());
        }
        let count = records.len();
        let catalog_bytes =
            serde_json::to_vec(&catalog).map_err(|_| "빌드 기록을 저장할 수 없습니다.")?;
        let previous_bytes: u64 = LIBRARY_CACHE
            .get_or_init(|| Mutex::new(LibraryCache::default()))
            .lock()
            .map_err(|_| "보관 기록 캐시에 접근할 수 없습니다.")?
            .manifest
            .iter()
            .map(|(_, size, _)| *size)
            .sum();
        if catalog_bytes.len() > 16 * 1024 * 1024
            || previous_bytes + catalog_bytes.len() as u64 > 32 * 1024 * 1024
        {
            return Err(
                "보관할 기록이 개별 16MB 또는 전체 32MB 메타데이터 제한을 초과했습니다.".into(),
            );
        }
        if bytes.len() > ARCHIVE_LIMIT
            || bytes.len() as u64
                != source
                    .metadata()
                    .map_err(|_| "원본 파일 정보를 읽을 수 없습니다.")?
                    .len()
        {
            return Err("가져오는 동안 파일 크기가 변경되었습니다.".into());
        }
        if !archive.exists() {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&archive)
                .map_err(|_| "빌드 기록 보관 파일을 만들 수 없습니다.")?;
            file.write_all(&bytes)
                .map_err(|_| "빌드 기록 파일을 저장할 수 없습니다.")?;
        } else {
            plain(&archive)?;
            let mut existing = Vec::new();
            File::open(&archive)
                .map_err(|_| "기존 보관 파일을 읽을 수 없습니다.")?
                .take((ARCHIVE_LIMIT + 1) as u64)
                .read_to_end(&mut existing)
                .map_err(|_| "기존 보관 파일을 읽을 수 없습니다.")?;
            if existing.len() > ARCHIVE_LIMIT || archive::sha256(&existing)? != digest {
                return Err("기존 보관 파일의 SHA256이 일치하지 않습니다.".into());
            }
        }
        let temporary = directory.join(format!(
            "{digest}.json.tmp-{}-{}",
            std::process::id(),
            now()
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "빌드 기록 목록을 저장할 수 없습니다.")?;
        let written = file.write_all(&catalog_bytes).and_then(|_| file.sync_all());
        drop(file);
        if written.is_err() {
            let _ = fs::remove_file(&temporary);
            return Err("빌드 기록 목록을 저장할 수 없습니다.".into());
        }
        if fs::rename(&temporary, index).is_err() {
            let _ = fs::remove_file(&temporary);
            return Err("빌드 기록 목록을 확정할 수 없습니다. 파일 상태를 확인하세요.".into());
        }
        return Ok(
            json!({"message":format!("빌드 기록 {count}개를 가져왔습니다. 엔진의 빌드·이미지·캐시는 변경하지 않았습니다."),"records":count,"archiveId":digest}),
        );
    }
    if request.kind != "export" {
        return Err("지원하지 않는 기록 전송 작업입니다.".into());
    }
    let path = local_path(&request.path, true)?;
    let bytes = if let Some(id) = &request.imported_id {
        let record = imported()?
            .iter()
            .find(|record| record["id"] == *id)
            .cloned()
            .ok_or("보관 기록을 찾을 수 없습니다.")?;
        let digest = text(&record, "archiveId");
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("보관 파일 식별 정보가 올바르지 않습니다.".into());
        }
        let archive = library()?.join(format!("{digest}.dockerbuild"));
        plain(&archive)?;
        let mut bytes = Vec::new();
        File::open(archive)
            .map_err(|_| "보관한 원본 파일을 찾을 수 없습니다.")?
            .take((ARCHIVE_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "보관 파일을 읽을 수 없습니다.")?;
        if bytes.len() > ARCHIVE_LIMIT || archive::sha256(&bytes)? != digest {
            return Err("보관한 원본 파일의 크기 또는 SHA256이 변경되었습니다.".into());
        }
        bytes
    } else {
        let client = crate::docker::connected()?;
        let builder = request.builder.as_deref().ok_or("빌더를 선택하세요.")?;
        let reference = request
            .reference
            .as_deref()
            .ok_or("내보낼 빌드 기록을 선택하세요.")?;
        let reference = cli_reference(&client, builder, reference)?;
        output(
            &client,
            &args(&["history", "export", "--builder", builder, &reference]),
            false,
            120,
            ARCHIVE_LIMIT,
        )?
    };
    if bytes.is_empty() || bytes.len() > ARCHIVE_LIMIT || !bytes.starts_with(&[0x1f, 0x8b]) {
        return Err(
            "유효한 gzip 빌드 기록 파일을 만들지 못했습니다. 64MB 이하의 기록을 선택하세요.".into(),
        );
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "새 빌드 기록 파일을 만들 수 없습니다. 파일 이름을 확인하세요.")?;
    file.write_all(&bytes)
        .map_err(|_| "기록 파일 쓰기에 실패했습니다. 불완전한 파일을 확인하세요.")?;
    Ok(json!({"message":"빌드 기록을 내보냈습니다.","path":request.path,"bytes":bytes.len()}))
}
pub fn transfer_start(request: TransferRequest, approved: bool) -> Result<Value, String> {
    if !approved {
        return Err("선택한 파일과 영향을 확인한 뒤 기록 전송을 승인하세요.".into());
    }
    if crate::image_build::is_building() {
        return Err("이미지 빌드를 마친 뒤 기록을 전송하세요.".into());
    }
    if !["import", "export"].contains(&request.kind.as_str()) {
        return Err("지원하지 않는 기록 작업입니다.".into());
    }
    local_path(&request.path, request.kind == "export")?;
    if ACTIVE.swap(true, Ordering::AcqRel) {
        return Err("빌드 기록을 전송하고 있습니다.".into());
    }
    let id = format!(
        "{}-{}-{}",
        std::process::id(),
        now(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let initial = json!({"id":id,"state":"running","kind":request.kind,"path":request.path,"startedAt":now(),"message":"빌드 기록을 처리하고 있습니다."});
    *TRANSFER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| {
            ACTIVE.store(false, Ordering::Release);
            "전송 상태를 저장할 수 없습니다."
        })? = Some(initial.clone());
    let worker_id = id.clone();
    if let Err(error) = thread::Builder::new()
        .name("dockslate-build-records".into())
        .spawn(move || {
            let outcome = transfer_run(&request);
            if let Ok(mut state) = TRANSFER.get_or_init(|| Mutex::new(None)).lock() {
                if let Some(job) = state.as_mut().filter(|job| job["id"] == worker_id) {
                    job["finishedAt"] = json!(now());
                    match outcome {
                        Ok(result) => {
                            job["state"] = json!("completed");
                            job["result"] = result.clone();
                            job["message"] = result["message"].clone();
                        }
                        Err(error) => {
                            job["state"] = json!("failed");
                            job["message"] = json!(error);
                        }
                    }
                }
            }
            ACTIVE.store(false, Ordering::Release);
        })
    {
        ACTIVE.store(false, Ordering::Release);
        return Err(format!("기록 전송을 시작할 수 없습니다: {error}"));
    }
    Ok(initial)
}

pub fn pick_file(save: bool) -> Result<Value, String> {
    #[cfg(windows)]
    {
        picker::pick(save).map(|path| json!({"path":path}))
    }
    #[cfg(not(windows))]
    {
        let _ = save;
        Err("파일 선택은 Windows에서 지원합니다.".into())
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
        max_custom_filter: u32,
        filter_index: u32,
        file: *mut u16,
        max_file: u32,
        file_title: *mut u16,
        max_file_title: u32,
        initial_directory: *const u16,
        title: *const u16,
        flags: u32,
        file_offset: u16,
        file_extension: u16,
        default_extension: *const u16,
        data: isize,
        hook: *mut c_void,
        template: *const u16,
        reserved: *mut c_void,
        reserved_size: u32,
        extended_flags: u32,
    }
    #[link(name = "comdlg32")]
    unsafe extern "system" {
        fn GetOpenFileNameW(value: *mut OpenFileName) -> i32;
        fn GetSaveFileNameW(value: *mut OpenFileName) -> i32;
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
            .name("dockslate-build-record-picker".into())
            .spawn(move || {
                let result = unsafe { CoInitializeEx(std::ptr::null_mut(), 0x2 | 0x4) };
                if result < 0 {
                    return Err(format!(
                        "파일 선택 창을 초기화할 수 없습니다: 0x{:08X}",
                        result as u32
                    ));
                }
                let _apartment = Apartment;
                let mut file = vec![0u16; 32768];
                let filter: Vec<_> = "Build records (*.dockerbuild)\0*.dockerbuild\0\0"
                    .encode_utf16()
                    .collect();
                let title: Vec<_> = if save {
                    "빌드 기록을 저장할 새 파일 선택\0"
                } else {
                    "가져올 빌드 기록 선택\0"
                }
                .encode_utf16()
                .collect();
                let extension: Vec<_> = "dockerbuild\0".encode_utf16().collect();
                let mut value: OpenFileName = unsafe { std::mem::zeroed() };
                value.size = std::mem::size_of::<OpenFileName>() as u32;
                value.filter = filter.as_ptr();
                value.filter_index = 1;
                value.file = file.as_mut_ptr();
                value.max_file = file.len() as u32;
                value.title = title.as_ptr();
                value.default_extension = extension.as_ptr();
                value.flags = 0x80000 | 0x800 | 0x8 | if save { 0 } else { 0x1000 };
                let result = unsafe {
                    if save {
                        GetSaveFileNameW(&mut value)
                    } else {
                        GetOpenFileNameW(&mut value)
                    }
                };
                if result == 0 {
                    let error = unsafe { CommDlgExtendedError() };
                    return if error == 0 {
                        Ok(None)
                    } else {
                        Err(format!("파일 선택 창 오류: {error}"))
                    };
                }
                Ok(Some(String::from_utf16_lossy(
                    &file[..file
                        .iter()
                        .position(|value| *value == 0)
                        .unwrap_or(file.len())],
                )))
            })
            .map_err(|_| "파일 선택 창 스레드를 시작할 수 없습니다.".to_owned())?
            .join()
            .map_err(|_| "파일 선택 창이 종료되었습니다.".to_owned())?
    }
}
