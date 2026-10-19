use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const FILE_LIMIT: u64 = 1024 * 1024;
const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
const CONTEXT_FILES: usize = 20_000;
const CONTEXT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
static ACTIVE: AtomicBool = AtomicBool::new(false);
static STORE: OnceLock<Mutex<Option<Selection>>> = OnceLock::new();
static JOB: OnceLock<Mutex<Option<Value>>> = OnceLock::new();

struct Selection {
    token: String,
    file: PathBuf,
    root: PathBuf,
    _pins: Vec<File>,
    source: Vec<u8>,
    project: String,
    prepared: Option<Prepared>,
    run: Option<RunPreview>,
    built: bool,
}
#[derive(Clone)]
struct Prepared {
    engine_id: String,
    config: Value,
    summary: Value,
    contexts: Vec<PathBuf>,
    fingerprint: String,
    has_build: bool,
}
struct RunPreview {
    token: String,
    created: Instant,
    config: Value,
    images: Vec<(String, String)>,
    image_ids: Vec<String>,
}
fn store() -> &'static Mutex<Option<Selection>> {
    STORE.get_or_init(|| Mutex::new(None))
}
fn jobs() -> &'static Mutex<Option<Value>> {
    JOB.get_or_init(|| Mutex::new(None))
}
pub fn is_busy() -> bool {
    ACTIVE.load(Ordering::Acquire)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn token() -> Result<String, String> {
    #[cfg(windows)]
    {
        #[link(name = "bcrypt")]
        unsafe extern "system" {
            fn BCryptGenRandom(
                provider: *mut std::ffi::c_void,
                bytes: *mut u8,
                length: u32,
                flags: u32,
            ) -> i32;
        }
        let mut bytes = [0u8; 16];
        if unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), 16, 2) } < 0 {
            return Err("가져오기 승인 토큰을 만들 수 없습니다.".into());
        }
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }
    #[cfg(not(windows))]
    {
        Err("파일 가져오기는 Windows에서 지원합니다.".into())
    }
}
fn plain(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let metadata =
            fs::symlink_metadata(ancestor).map_err(|_| "선택한 경로에 접근할 수 없습니다.")?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("링크 또는 재분석 지점이 있는 경로는 가져올 수 없습니다.".into());
            }
        }
        if metadata.file_type().is_symlink() {
            return Err("링크가 있는 경로는 가져올 수 없습니다.".into());
        }
    }
    Ok(())
}
fn pin(path: &Path, directory: bool) -> Result<File, String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .access_mode(0x80)
            .share_mode(if directory { 3 } else { 1 })
            .custom_flags(if directory { 0x02200000 } else { 0x00200000 })
            .open(path)
            .map_err(|_| {
                "가져올 파일 또는 폴더를 고정할 수 없습니다. 편집 작업을 마친 뒤 다시 선택하세요."
                    .into()
            })
    }
    #[cfg(not(windows))]
    {
        let _ = directory;
        File::open(path).map_err(|_| "파일을 열 수 없습니다.".into())
    }
}
fn display(path: &Path) -> Result<String, String> {
    Ok(path
        .to_str()
        .ok_or("파일 경로 인코딩을 확인할 수 없습니다.")?
        .strip_prefix("\\\\?\\")
        .unwrap_or(path.to_str().unwrap_or(""))
        .into())
}
fn selected_path(value: &str) -> Result<(PathBuf, PathBuf, Vec<File>, Vec<u8>), String> {
    let bytes = value.as_bytes();
    if bytes.len() < 4
        || bytes.len() > 32760
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || ![b'\\', b'/'].contains(&bytes[2])
        || value[2..].contains(':')
        || value.chars().any(char::is_control)
    {
        return Err("Windows 로컬 드라이브의 파일을 선택하세요.".into());
    }
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
            return Err("네트워크 드라이브의 파일은 지원하지 않습니다.".into());
        }
    }
    let original = PathBuf::from(value);
    plain(&original)?;
    let file = fs::canonicalize(&original).map_err(|_| "선택한 파일을 찾을 수 없습니다.")?;
    let root = file
        .parent()
        .filter(|parent| parent.parent().is_some())
        .ok_or("드라이브 루트 대신 프로젝트 폴더 안의 파일을 선택하세요.")?
        .to_owned();
    let mut pins = Vec::new();
    for ancestor in root.ancestors() {
        pins.push(pin(ancestor, true)?);
    }
    pins.push(pin(&file, false)?);
    plain(&file)?;
    let metadata = fs::metadata(&file).map_err(|_| "선택한 파일 정보를 읽을 수 없습니다.")?;
    if !metadata.is_file() || metadata.len() > FILE_LIMIT {
        return Err("1 MiB 이하의 일반 텍스트 파일을 선택하세요.".into());
    }
    let mut source = Vec::new();
    File::open(&file)
        .map_err(|_| "선택한 파일을 읽을 수 없습니다.")?
        .take(FILE_LIMIT + 1)
        .read_to_end(&mut source)
        .map_err(|_| "선택한 파일을 읽을 수 없습니다.")?;
    if source.len() as u64 > FILE_LIMIT
        || source.contains(&0)
        || std::str::from_utf8(&source).is_err()
    {
        return Err("UTF-8 텍스트 파일만 가져올 수 있습니다 (최대 1 MiB).".into());
    }
    Ok((file, root, pins, source))
}
pub fn pick_file(kind: String) -> Result<Value, String> {
    if !matches!(kind.as_str(), "dockerfile" | "compose") {
        return Err("지원하지 않는 파일 종류입니다.".into());
    }
    if is_busy() {
        return Err("가져오기 작업이 진행 중입니다.".into());
    }
    #[cfg(windows)]
    let path = picker::pick(&kind)?;
    #[cfg(not(windows))]
    let path: Option<String> = None;
    let Some(path) = path else {
        return Ok(json!({"token":null,"path":null,"kind":kind}));
    };
    let (file, root, pins, source) = selected_path(&path)?;
    if kind == "compose"
        && !file.extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("yml") || extension.eq_ignore_ascii_case("yaml")
        })
    {
        return Err("Compose .yaml 또는 .yml 파일을 선택하세요.".into());
    }
    let id = token()?;
    let result = json!({"token":id,"kind":kind,"path":display(&file)?,"contextPath":display(&root)?,"dockerfile":file.file_name().and_then(|name| name.to_str())});
    if kind == "compose" {
        let mut guard = store()
            .lock()
            .map_err(|_| "가져오기 상태를 저장할 수 없습니다.")?;
        if is_busy() {
            return Err("가져오기 작업이 진행 중입니다.".into());
        }
        *guard = Some(Selection {
            project: format!("dockslate-import-{id}"),
            token: id,
            file,
            root,
            _pins: pins,
            source,
            prepared: None,
            run: None,
            built: false,
        });
    }
    Ok(result)
}
fn selected<'a>(guard: &'a mut Option<Selection>, id: &str) -> Result<&'a mut Selection, String> {
    guard
        .as_mut()
        .filter(|value| value.token == id)
        .ok_or_else(|| "파일 선택이 만료되었습니다. 파일을 다시 선택하세요.".into())
}
fn source_safe(source: &[u8]) -> Result<(), String> {
    let value = std::str::from_utf8(source)
        .map_err(|_| "UTF-8 Compose 파일을 선택하세요.")?
        .to_ascii_lowercase();
    if value.contains('$')
        || value.contains('\\')
        || value.contains('!')
        || value
            .chars()
            .any(|value| value.is_control() && !['\r', '\n', '\t'].contains(&value))
    {
        return Err("환경 변수 치환·역슬래시 이스케이프·YAML 태그는 가져오기에서 지원하지 않습니다. 값과 경로를 명시한 Compose 파일을 선택하세요.".into());
    }
    if [
        "include",
        "extends",
        "env_file",
        "label_file",
        "secrets",
        "configs",
        "credential_spec",
    ]
    .iter()
    .any(|key| value.contains(key))
    {
        return Err("include·extends·env_file·label_file·secrets·configs·credential_spec 참조는 지원하지 않습니다. 선택하지 않은 파일이나 비밀 파일은 읽지 않습니다.".into());
    }
    Ok(())
}
fn system_wsl() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
        }
        let mut buffer = vec![0u16; 32768];
        let length =
            unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
        if length == 0 || length >= buffer.len() {
            return Err("Windows 시스템 경로를 확인할 수 없습니다.".into());
        }
        Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..length])).join("wsl.exe"))
    }
    #[cfg(not(windows))]
    {
        Err("Compose 가져오기는 Windows에서 지원합니다.".into())
    }
}
fn verify(client: &crate::docker::Client) -> Result<(), String> {
    client.transport.verify_tool_session()?;
    if text(&client.json("GET", "/info")?, "ID") != client.identity {
        return Err("엔진 ID가 변경되었습니다. 파일을 다시 선택하세요.".into());
    }
    Ok(())
}
fn command(
    client: &crate::docker::Client,
    root: &str,
    project: &str,
    config: &[u8],
    operation: &str,
) -> Result<Vec<u8>, String> {
    let mutation = matches!(operation, "build" | "up");
    verify(client)?;
    if mutation {
        client.transport.verify_tool_start()?;
    }
    let seconds = match operation {
        "config" => 30,
        "build" => 900,
        "up" => 120,
        _ => return Err("지원하지 않는 Compose 작업입니다.".into()),
    };
    let mut arguments: Vec<String> = [
        "--distribution",
        "DockSlate",
        "--user",
        "root",
        "--exec",
        "/usr/bin/timeout",
        "--signal=TERM",
        "--kill-after=5s",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    arguments.push(format!("{seconds}s"));
    arguments.extend(
        [
            "/usr/bin/env",
            "-i",
            "PATH=/usr/bin:/bin",
            "HOME=/nonexistent",
            "DOCKER_CONFIG=/nonexistent/dockslate-import",
            "COMPOSE_DISABLE_ENV_FILE=1",
            "COMPOSE_BAKE=false",
            "BUILDX_BUILDER=default",
            "DOCKER_BUILDKIT=1",
            "/usr/bin/docker",
            "--host",
            "unix:///var/run/docker.sock",
            "compose",
            "--ansi",
            "never",
            "--progress",
            "plain",
            "--env-file",
            "/dev/null",
            "--project-name",
            project,
            "--project-directory",
            root,
            "--file",
            "-",
        ]
        .into_iter()
        .map(String::from),
    );
    match operation {
        "config" => arguments.extend(
            [
                "config",
                "--format",
                "json",
                "--no-env-resolution",
                "--no-interpolate",
                "--no-path-resolution",
            ]
            .into_iter()
            .map(String::from),
        ),
        "build" => arguments.extend(
            ["build", "--builder", "default"]
                .into_iter()
                .map(String::from),
        ),
        "up" => arguments.extend(
            [
                "up",
                "--detach",
                "--no-build",
                "--pull",
                "never",
                "--no-recreate",
            ]
            .into_iter()
            .map(String::from),
        ),
        _ => unreachable!(),
    }
    let output = crate::process::execute(&system_wsl()?, &arguments, Some(config), Duration::from_secs(seconds + 10), OUTPUT_LIMIT)
        .map_err(|_| if mutation { "Compose 작업이 시간 또는 출력 한도를 초과했습니다. 부분 결과가 남을 수 있으므로 전체 새로고침 후 확인하세요.".to_owned() } else { "Compose 구성을 제한 시간 안에 읽을 수 없습니다.".to_owned() })?;
    if !output.status.success() {
        return Err(format!("Compose {operation} 작업 실패 (종료 코드 {}). 원본 구성 또는 전용 WSL의 Compose 지원을 확인하세요. 비밀 값 보호를 위해 원본 명령 출력은 표시하지 않습니다.{}", output.status.code().map_or_else(|| "미확인".into(), |code| code.to_string()), if mutation { " 부분 생성된 리소스가 있을 수 있으므로 전체 새로고침으로 확인하세요." } else { "" }));
    }
    verify(client)?;
    Ok(output.stdout)
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}
fn keys(value: &Value, allowed: &[&str], location: &str) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{location} 형식을 확인하세요."))?;
    if object
        .keys()
        .any(|key| !key.starts_with("x-") && !allowed.contains(&key.as_str()))
    {
        return Err(format!("{location}에 가져오기에서 지원하지 않는 옵션이 있습니다. 권한·장치·호스트 공유·외부 입력 옵션은 허용하지 않습니다."));
    }
    Ok(())
}
fn labels(value: &mut Value, id: &str) -> Result<(), String> {
    if value.is_null() {
        *value = json!({});
    }
    let labels = value
        .as_object_mut()
        .ok_or("라벨 형식이 올바르지 않습니다.")?;
    if labels
        .keys()
        .any(|key| key.starts_with("com.docker.compose.") || key.starts_with("io.dockslate."))
    {
        return Err("Compose 또는 DockSlate 소유권 라벨은 직접 지정할 수 없습니다.".into());
    }
    labels.insert("io.dockslate.import".into(), json!(id));
    Ok(())
}
fn relative(root: &Path, path: &str) -> Result<PathBuf, String> {
    if path.is_empty()
        || path.len() > 2048
        || path.contains([':', '\\'])
        || path.chars().any(char::is_control)
        || path.starts_with('/')
        || Path::new(path).components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("빌드 경로는 선택한 Compose 폴더 안의 상대 경로만 허용합니다. 원격·절대·상위 폴더 경로는 지원하지 않습니다.".into());
    }
    let path = root.join(path);
    plain(&path)?;
    let path = fs::canonicalize(path).map_err(|_| "Compose 빌드 경로를 찾을 수 없습니다.")?;
    if !path.starts_with(root) {
        return Err("Compose 폴더 밖의 빌드 경로는 허용하지 않습니다.".into());
    }
    Ok(path)
}
fn normalize(
    selection: &Selection,
    client: &crate::docker::Client,
    mut config: Value,
) -> Result<Prepared, String> {
    keys(
        &config,
        &["name", "version", "services", "networks", "volumes"],
        "Compose",
    )?;
    config["name"] = json!(selection.project);
    let mut contexts = Vec::<PathBuf>::new();
    let mut summaries = Vec::new();
    let mut has_build = false;
    let services = config["services"]
        .as_object_mut()
        .ok_or("Compose 서비스가 없습니다.")?;
    if services.is_empty() || services.len() > 16 {
        return Err("1~16개 서비스가 있는 Compose 파일만 가져올 수 있습니다.".into());
    }
    for (name, service) in services {
        if !valid_name(name) || *name != name.to_ascii_lowercase() {
            return Err(
                "Compose 서비스 이름은 영문 소문자·숫자·_.-로 지정하세요 (최대 63자).".into(),
            );
        }
        keys(
            service,
            &[
                "image",
                "build",
                "command",
                "entrypoint",
                "environment",
                "ports",
                "volumes",
                "networks",
                "depends_on",
                "restart",
                "healthcheck",
                "working_dir",
                "user",
                "hostname",
                "domainname",
                "init",
                "tty",
                "stdin_open",
                "stop_grace_period",
                "stop_signal",
                "expose",
                "labels",
                "logging",
                "read_only",
                "cpus",
                "mem_limit",
                "mem_reservation",
                "pids_limit",
                "platform",
            ],
            "서비스",
        )?;
        let mut build_summary = Value::Null;
        if !service["build"].is_null() {
            has_build = true;
            let build = &mut service["build"];
            keys(
                build,
                &[
                    "context",
                    "dockerfile",
                    "args",
                    "target",
                    "no_cache",
                    "pull",
                ],
                "빌드",
            )?;
            let context = relative(&selection.root, build["context"].as_str().unwrap_or("."))?;
            if !context.is_dir() {
                return Err("빌드 context는 프로젝트 폴더여야 합니다.".into());
            }
            let dockerfile = relative(
                &context,
                build["dockerfile"].as_str().unwrap_or("Dockerfile"),
            )?;
            if !dockerfile.is_file()
                || fs::metadata(&dockerfile)
                    .map_err(|_| "Dockerfile 정보를 확인할 수 없습니다.")?
                    .len()
                    > FILE_LIMIT
            {
                return Err("빌드 Dockerfile은 1 MiB 이하의 일반 파일이어야 합니다.".into());
            }
            let guest_context = client.transport.build_path(&display(&context)?)?;
            let guest_file = client.transport.build_path(&display(&dockerfile)?)?;
            build["context"] = json!(guest_context);
            build["dockerfile"] = json!(guest_file);
            build_summary =
                json!({"contextPath":display(&context)?,"dockerfile":display(&dockerfile)?});
            if !contexts.contains(&context) {
                contexts.push(context);
            }
            service["image"] = json!(format!(
                "{}-{}:import",
                selection.project,
                name.to_ascii_lowercase()
            ));
        }
        let image = service["image"].as_str().unwrap_or("");
        if image.is_empty()
            || image.len() > 256
            || image.starts_with('-')
            || image
                .chars()
                .any(|value| value.is_control() || value.is_whitespace())
        {
            return Err("각 서비스에 로컬 이미지 또는 빌드 구성이 필요합니다.".into());
        }
        let image = image.to_owned();
        if let Some(mounts) = service["volumes"].as_array() {
            for mount in mounts {
                keys(
                    mount,
                    &["type", "source", "target", "read_only", "volume"],
                    "볼륨 연결",
                )?;
                if text(mount, "type") != "volume" || !valid_name(text(mount, "source")) {
                    return Err("서비스 볼륨은 Compose가 새로 만드는 이름 있는 볼륨만 지원합니다. 호스트·소켓·런타임 디스크 경로는 연결하지 않습니다.".into());
                }
                if !mount["volume"].is_null() {
                    keys(&mount["volume"], &["nocopy"], "볼륨 옵션")?;
                }
            }
        }
        if let Some(ports) = service["ports"].as_array() {
            if ports.len() > 32 {
                return Err("서비스마다 포트 연결은 최대 32개까지 허용합니다.".into());
            }
            for port in ports {
                keys(
                    port,
                    &[
                        "target",
                        "published",
                        "host_ip",
                        "protocol",
                        "mode",
                        "name",
                        "app_protocol",
                    ],
                    "포트",
                )?;
                if !matches!(port["mode"].as_str(), None | Some("ingress")) {
                    return Err("호스트 모드 포트는 지원하지 않습니다.".into());
                }
            }
        }
        if let Some(networks) = service["networks"].as_object() {
            for options in networks.values() {
                if !options.is_null() {
                    keys(options, &["aliases"], "서비스 네트워크")?;
                }
            }
        }
        if !service["logging"].is_null() {
            keys(&service["logging"], &["driver", "options"], "로그")?;
            if !matches!(
                service["logging"]["driver"].as_str(),
                None | Some("local" | "json-file")
            ) {
                return Err("외부로 로그를 전송하는 드라이버는 지원하지 않습니다.".into());
            }
            if !service["logging"]["options"].is_null() {
                keys(
                    &service["logging"]["options"],
                    &["max-size", "max-file"],
                    "로그 옵션",
                )?;
            }
        }
        labels(&mut service["labels"], &selection.token)?;
        summaries.push(json!({"name":name,"image":image,"build":build_summary,"ports":service["ports"],"volumes":service["volumes"],"networks":service["networks"].as_object().map(|value| value.keys().collect::<Vec<_>>()).unwrap_or_default(),"environmentKeys":service["environment"].as_object().map(|value| value.keys().collect::<Vec<_>>()).unwrap_or_default()}));
    }
    let mut resources = Vec::new();
    for category in ["volumes", "networks"] {
        if let Some(values) = config.get_mut(category).and_then(Value::as_object_mut) {
            for (name, value) in values {
                if !valid_name(name) {
                    return Err("볼륨과 네트워크 이름을 확인하세요 (최대 63자).".into());
                }
                if value.is_null() {
                    *value = json!({});
                }
                keys(
                    value,
                    if category == "volumes" {
                        &["name", "labels", "driver", "external"]
                    } else {
                        &[
                            "name",
                            "labels",
                            "driver",
                            "external",
                            "internal",
                            "attachable",
                            "enable_ipv6",
                            "enable_ipv4",
                        ]
                    },
                    "프로젝트 리소스",
                )?;
                if !matches!(value["external"], Value::Null | Value::Bool(false))
                    || (!value["driver"].is_null()
                        && text(value, "driver")
                            != if category == "volumes" {
                                "local"
                            } else {
                                "bridge"
                            })
                {
                    return Err(
                        "외부 리소스와 사용자 지정 볼륨·네트워크 드라이버는 지원하지 않습니다."
                            .into(),
                    );
                }
                let owned = format!("{}_{}", selection.project, name);
                value["name"] = json!(owned);
                labels(&mut value["labels"], &selection.token)?;
                resources.push(json!({"kind":category,"key":name,"name":owned}));
            }
        }
    }
    let (fingerprint, _) = context_snapshot(&contexts)?;
    let summary = json!({"token":selection.token,"path":display(&selection.file)?,"contextPath":display(&selection.root)?,"project":selection.project,"engineId":client.identity,"services":summaries,"resources":resources,"hasBuild":has_build,"contextFingerprint":fingerprint,"warnings":["빌드는 새 DockSlate 전용 이미지 태그를 사용합니다. 컨테이너 실행은 빌드 뒤 별도로 승인합니다.","이미지 전용 서비스는 로컬 이미지가 있어야 실행할 수 있습니다. 실행 중 이미지를 자동으로 내려받지 않습니다.","빌드 중 전용 WSL이 프로젝트 빌드 폴더를 읽으며 캐시와 이미지가 디스크를 사용합니다."]});
    Ok(Prepared {
        engine_id: client.identity.clone(),
        config,
        summary,
        contexts,
        fingerprint,
        has_build,
    })
}
fn context_snapshot(contexts: &[PathBuf]) -> Result<(String, Vec<File>), String> {
    let started = Instant::now();
    let mut paths = Vec::new();
    let mut pins = Vec::new();
    let mut total = 0u64;
    let mut seen = HashSet::<PathBuf>::new();
    let mut queue = contexts.to_vec();
    while let Some(path) = queue.pop() {
        if !seen.insert(path.clone()) {
            continue;
        }
        if seen.len() > CONTEXT_FILES || started.elapsed() > Duration::from_secs(20) {
            return Err("빌드 폴더 조회 한도를 초과했습니다 (20,000개 항목, 20초). 더 작은 프로젝트 폴더를 선택하세요.".into());
        }
        plain(&path)?;
        let metadata = fs::metadata(&path).map_err(|_| "빌드 폴더 항목을 확인할 수 없습니다.")?;
        if !metadata.is_dir() && !metadata.is_file() {
            return Err("빌드 폴더의 특수 파일은 지원하지 않습니다.".into());
        }
        if metadata.is_dir()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    matches!(
                        name.to_ascii_lowercase().as_str(),
                        ".ssh" | ".aws" | ".azure" | ".kube" | ".docker" | ".gnupg" | ".codex"
                    )
                })
        {
            return Err("빌드 폴더에 인증 정보가 들어갈 수 있는 설정 폴더가 있습니다. 해당 폴더를 포함하지 않은 별도 빌드 폴더를 선택하세요.".into());
        }
        if metadata.is_file() {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if name == ".env"
                || name.starts_with(".env.")
                || matches!(
                    name.as_str(),
                    "id_rsa" | "id_ed25519" | "credentials" | "credentials.json"
                )
                || name.ends_with(".pem")
                || name.ends_with(".key")
            {
                return Err("빌드 폴더에 비밀 파일로 취급하는 항목이 있습니다 (.env, 개인 키, credentials). 해당 파일을 포함하지 않은 별도 빌드 폴더를 선택하세요.".into());
            }
            total = total
                .checked_add(metadata.len())
                .ok_or("빌드 폴더 크기를 확인할 수 없습니다.")?;
            if total > CONTEXT_BYTES {
                return Err("가져오기 빌드 폴더는 총 2 GiB까지 지원합니다.".into());
            }
        }
        pins.push(pin(&path, metadata.is_dir())?);
        let modified = metadata
            .modified()
            .map_err(|_| "빌드 파일 변경 시각을 확인할 수 없습니다.")?
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "빌드 파일 시각을 확인할 수 없습니다.")?
            .as_nanos()
            .to_string();
        paths.push(json!([
            display(&path)?,
            metadata.is_dir(),
            metadata.len(),
            modified
        ]));
        if metadata.is_dir() {
            for entry in fs::read_dir(&path).map_err(|_| "빌드 폴더를 읽을 수 없습니다.")?
            {
                queue.push(
                    entry
                        .map_err(|_| "빌드 폴더 항목을 읽을 수 없습니다.")?
                        .path(),
                );
            }
        }
    }
    paths.sort_by_cached_key(Value::to_string);
    Ok((
        crate::builds::content_sha256(
            &serde_json::to_vec(&paths).map_err(|_| "빌드 폴더 상태를 구성할 수 없습니다.")?,
        )?,
        pins,
    ))
}
fn encoded(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
fn no_collisions(
    prepared: &Prepared,
    client: &crate::docker::Client,
    project: &str,
    check_images: bool,
) -> Result<(), String> {
    if client.identity != prepared.engine_id {
        return Err("The selected Docker engine changed. Select the file again.".into());
    }
    verify(client)?;
    if client.containers()?.iter().any(|value| {
        text(&value["Labels"], "com.docker.compose.project") == project
            || value["Names"].as_array().is_some_and(|names| {
                names
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|name| name.trim_start_matches('/').starts_with(project))
            })
    }) {
        return Err("동일한 프로젝트 이름의 컨테이너가 이미 있습니다. 기존 프로젝트를 변경하지 않도록 가져오기를 중단했습니다. 파일을 다시 선택하세요.".into());
    }
    let networks = client.json("GET", "/networks")?;
    let volumes = client.json("GET", "/volumes")?;
    let names: HashSet<_> = prepared.summary["resources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| value["name"].as_str())
        .collect();
    for values in [networks.as_array(), volumes["Volumes"].as_array()]
        .into_iter()
        .flatten()
    {
        if values.iter().any(|value| {
            text(&value["Labels"], "com.docker.compose.project") == project
                || names.contains(text(value, "Name"))
        }) {
            return Err("가져올 볼륨 또는 네트워크 이름이 이미 사용 중입니다. 기존 데이터를 보존하기 위해 중단했습니다.".into());
        }
    }
    if check_images {
        let images = client.json("GET", "/images/json?all=1")?;
        for service in prepared.config["services"]
            .as_object()
            .ok_or("서비스 구성을 확인할 수 없습니다.")?
            .values()
            .filter(|value| !value["build"].is_null())
        {
            if images
                .as_array()
                .ok_or("로컬 이미지 목록을 확인할 수 없습니다.")?
                .iter()
                .any(|image| {
                    image["RepoTags"]
                        .as_array()
                        .is_some_and(|tags| tags.iter().any(|tag| tag == &service["image"]))
                })
            {
                return Err("가져오기 이미지 태그가 이미 있습니다. 기존 이미지를 덮어쓰지 않도록 파일을 다시 선택하세요.".into());
            }
        }
    }
    Ok(())
}
pub fn preview(id: String) -> Result<Value, String> {
    if is_busy() {
        return Err("가져오기 작업이 진행 중입니다.".into());
    }
    let mut guard = store()
        .lock()
        .map_err(|_| "가져오기 상태에 접근할 수 없습니다.")?;
    let selection = selected(&mut guard, &id)?;
    source_safe(&selection.source)?;
    let client = crate::docker::connected()?;
    let root = client.transport.build_path(&display(&selection.root)?)?;
    let bytes = command(
        &client,
        &root,
        &selection.project,
        &selection.source,
        "config",
    )?;
    let config: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Compose 정규화 JSON을 읽을 수 없습니다.")?;
    let prepared = normalize(selection, &client, config)?;
    no_collisions(&prepared, &client, &selection.project, true)?;
    let result = prepared.summary.clone();
    selection.prepared = Some(prepared);
    selection.run = None;
    selection.built = false;
    Ok(result)
}
fn finish(id: &str, result: Result<(), String>) {
    if let Ok(mut guard) = jobs().lock() {
        if let Some(job) = guard.as_mut().filter(|job| job["id"] == id) {
            job["state"] = json!(if result.is_ok() {
                "completed"
            } else {
                "failed"
            });
            job["error"] = json!(result.err());
            job["finishedAt"] = json!(now());
            job["logs"] = json!(if job["operation"] == "build" {
                "Compose 빌드 작업이 종료되었습니다. 서비스별 이미지와 전체 새로고침 결과를 확인하세요."
            } else {
                "Compose 실행 작업이 종료되었습니다. Containers에서 서비스 상태를 확인하세요."
            });
        }
    }
    ACTIVE.store(false, Ordering::Release);
}
fn launch(
    id: String,
    operation: &'static str,
    project: String,
    task: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<Value, String> {
    let initial = json!({"id":id,"operation":operation,"project":project,"state":"running","logs":if operation == "build" { "전용 WSL의 default 빌더에서 Compose 서비스를 빌드합니다. 최대 15분 동안 실행합니다." } else { "승인된 Compose 서비스와 새 볼륨·네트워크를 생성하고 시작합니다. 최대 2분 동안 실행합니다." },"error":null,"startedAt":now()});
    *jobs()
        .lock()
        .map_err(|_| "가져오기 작업을 기록할 수 없습니다.")? = Some(initial.clone());
    let job_id = id.clone();
    if thread::Builder::new()
        .name("dockslate-compose-import".into())
        .spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(task))
                .unwrap_or_else(|_| Err("Compose 작업이 예기치 않게 종료되었습니다. 부분 결과를 전체 새로고침으로 확인하세요.".into()));
            finish(&job_id, outcome);
        })
        .is_err()
    {
        finish(&id, Err("Compose 작업 스레드를 시작할 수 없습니다.".into()));
        return job_status(id);
    }
    Ok(initial)
}
pub fn build_start(id: String) -> Result<Value, String> {
    if ACTIVE.swap(true, Ordering::AcqRel) {
        return Err("Compose 작업이 이미 진행 중입니다.".into());
    }
    let outcome = (|| {
        if crate::image_build::is_building()
            || crate::builds::is_busy()
            || crate::volumes::is_busy()
        {
            return Err("다른 빌드 또는 파일 작업을 마친 뒤 가져오세요.".into());
        }
        let mut guard = store()
            .lock()
            .map_err(|_| "가져오기 상태에 접근할 수 없습니다.")?;
        let selection = selected(&mut guard, &id)?;
        let prepared = selection
            .prepared
            .as_ref()
            .ok_or("Compose 미리보기를 먼저 확인하세요.")?
            .clone();
        if selection.built {
            return Err("이미 빌드한 가져오기입니다. 실행 미리보기를 확인하세요.".into());
        }
        let client = crate::docker::connected()?;
        no_collisions(&prepared, &client, &selection.project, true)?;
        let (fingerprint, pins) = context_snapshot(&prepared.contexts)?;
        if fingerprint != prepared.fingerprint {
            return Err("빌드 폴더가 미리보기 이후 변경되었습니다. 파일을 다시 선택하세요.".into());
        }
        let root = client.transport.build_path(&display(&selection.root)?)?;
        let project = selection.project.clone();
        let config =
            serde_json::to_vec(&prepared.config).map_err(|_| "빌드 구성을 준비할 수 없습니다.")?;
        selection.run = None;
        let job_id = token()?;
        drop(guard);
        launch(job_id, "build", project.clone(), move || {
            let _pins = pins;
            if prepared.has_build {
                command(&client, &root, &project, &config, "build")?;
            }
            let (fingerprint, _) = context_snapshot(&prepared.contexts)?;
            if fingerprint != prepared.fingerprint {
                return Err("빌드 중 소스 폴더가 변경되었습니다. 실행을 차단했습니다. 파일을 다시 선택하세요.".into());
            }
            let mut guard = store()
                .lock()
                .map_err(|_| "빌드 완료 상태를 기록할 수 없습니다.")?;
            selected(&mut guard, &id)?.built = true;
            Ok(())
        })
    })();
    if outcome.is_err() {
        ACTIVE.store(false, Ordering::Release);
    }
    outcome
}
fn image_id(client: &crate::docker::Client, reference: &str) -> Result<String, String> {
    let image = client.json("GET", &format!("/images/{}/json", encoded(reference))).map_err(|_| "서비스 이미지가 로컬에 없습니다. Images에서 먼저 내려받은 뒤 실행 미리보기를 다시 확인하세요.")?;
    let id = text(&image, "Id");
    if id.len() != 71
        || !id.starts_with("sha256:")
        || !id[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("서비스 이미지 ID를 검증할 수 없습니다.".into());
    }
    Ok(id.into())
}
pub fn run_preview(id: String) -> Result<Value, String> {
    if is_busy() {
        return Err("Compose 작업을 마친 뒤 실행하세요.".into());
    }
    let mut guard = store()
        .lock()
        .map_err(|_| "가져오기 상태에 접근할 수 없습니다.")?;
    let selection = selected(&mut guard, &id)?;
    if !selection.built {
        return Err("Compose 빌드를 먼저 완료하세요.".into());
    }
    let prepared = selection
        .prepared
        .as_ref()
        .ok_or("Compose 미리보기가 없습니다.")?;
    let client = crate::docker::connected()?;
    no_collisions(prepared, &client, &selection.project, false)?;
    if context_snapshot(&prepared.contexts)?.0 != prepared.fingerprint {
        return Err("빌드 폴더가 변경되었습니다. 파일을 다시 선택하고 빌드하세요.".into());
    }
    let mut config = prepared.config.clone();
    let mut images = Vec::new();
    let mut image_ids = Vec::new();
    for service in config["services"]
        .as_object_mut()
        .ok_or("서비스 구성이 없습니다.")?
        .values_mut()
    {
        let reference = text(service, "image").to_owned();
        let image = image_id(&client, &reference)?;
        images.push((reference, image.clone()));
        image_ids.push(image.clone());
        service["image"] = json!(image);
        service
            .as_object_mut()
            .ok_or("서비스 구성을 확인할 수 없습니다.")?
            .remove("build");
    }
    let approval = token()?;
    let mut result = prepared.summary.clone();
    result["previewToken"] = json!(approval);
    result["imageIds"] = json!(image_ids);
    result["expiresInSeconds"] = json!(120);
    result["impact"] = json!("표시된 서비스 컨테이너와 새 프로젝트 볼륨·네트워크를 만들고 즉시 시작합니다. 공개 포트로 접근할 수 있습니다. 컨테이너 시작 명령과 환경은 선택한 Compose 구성대로 실행하며 이미지는 자동으로 내려받지 않습니다. 실패 시 일부 리소스가 남을 수 있습니다.");
    selection.run = Some(RunPreview {
        token: approval,
        created: Instant::now(),
        config,
        images,
        image_ids,
    });
    Ok(result)
}
pub fn run_start(approval: String, approved: bool) -> Result<Value, String> {
    if !approved {
        return Err("Compose 실행 승인이 필요합니다.".into());
    }
    if ACTIVE.swap(true, Ordering::AcqRel) {
        return Err("Compose 작업이 이미 진행 중입니다.".into());
    }
    let outcome = (|| {
        if crate::image_build::is_building()
            || crate::builds::is_busy()
            || crate::volumes::is_busy()
        {
            return Err("다른 빌드 또는 파일 작업을 마친 뒤 실행하세요.".into());
        }
        let mut guard = store()
            .lock()
            .map_err(|_| "가져오기 상태에 접근할 수 없습니다.")?;
        let selection = guard.as_mut().ok_or("가져오기 선택이 없습니다.")?;
        let run = selection
            .run
            .take()
            .filter(|run| {
                run.token == approval && run.created.elapsed() <= Duration::from_secs(120)
            })
            .ok_or("실행 승인이 만료되었습니다. 미리보기를 다시 확인하세요.")?;
        let prepared = selection
            .prepared
            .as_ref()
            .ok_or("가져오기 구성이 없습니다.")?
            .clone();
        let client = crate::docker::connected()?;
        no_collisions(&prepared, &client, &selection.project, false)?;
        let (fingerprint, pins) = context_snapshot(&prepared.contexts)?;
        if fingerprint != prepared.fingerprint {
            return Err("소스 폴더가 변경되었습니다. 파일을 다시 선택하고 빌드하세요.".into());
        }
        for (reference, expected) in &run.images {
            if image_id(&client, reference)? != *expected {
                return Err(
                    "승인 이후 서비스 이미지가 변경되었습니다. 실행 미리보기를 다시 확인하세요."
                        .into(),
                );
            }
        }
        for image in &run.image_ids {
            if image_id(&client, image)? != *image {
                return Err("승인한 로컬 이미지가 없어졌습니다. 실행을 중단했습니다.".into());
            }
        }
        let root = client.transport.build_path(&display(&selection.root)?)?;
        let project = selection.project.clone();
        let config =
            serde_json::to_vec(&run.config).map_err(|_| "실행 구성을 준비할 수 없습니다.")?;
        let job_id = token()?;
        drop(guard);
        launch(job_id, "run", project.clone(), move || {
            let _pins = pins;
            no_collisions(&prepared, &client, &project, false)?;
            command(&client, &root, &project, &config, "up")?;
            let expected = prepared.config["services"]
                .as_object()
                .ok_or("실행할 서비스 목록을 확인할 수 없습니다.")?;
            let containers = client.containers()?;
            for service in expected.keys() {
                let matches = containers
                    .iter()
                    .filter(|container| {
                        text(&container["Labels"], "com.docker.compose.project") == project
                            && text(&container["Labels"], "com.docker.compose.service") == service
                            && container["Labels"]["io.dockslate.import"]
                                == prepared.summary["token"]
                    })
                    .count();
                if matches != 1 {
                    return Err("Compose 실행 뒤 서비스 소유권 라벨을 확인하지 못했습니다. 전체 새로고침으로 부분 생성 결과를 확인하세요.".into());
                }
            }
            Ok(())
        })
    })();
    if outcome.is_err() {
        ACTIVE.store(false, Ordering::Release);
    }
    outcome
}
pub fn job_status(id: String) -> Result<Value, String> {
    jobs()
        .lock()
        .map_err(|_| "Compose 작업 상태를 읽을 수 없습니다.")?
        .as_ref()
        .filter(|job| job["id"] == id)
        .cloned()
        .ok_or_else(|| "Compose 작업을 찾을 수 없습니다.".into())
}
pub fn discard(id: String) -> Result<Value, String> {
    if is_busy() {
        return Err("진행 중인 가져오기는 닫을 수 없습니다.".into());
    }
    let mut guard = store()
        .lock()
        .map_err(|_| "가져오기 상태에 접근할 수 없습니다.")?;
    if guard.as_ref().is_some_and(|value| value.token == id) {
        *guard = None;
    }
    Ok(json!({"discarded":true}))
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
    pub fn pick(kind: &str) -> Result<Option<String>, String> {
        let compose = kind == "compose";
        thread::Builder::new()
            .name("dockslate-import-picker".into())
            .spawn(move || {
                if unsafe { CoInitializeEx(std::ptr::null_mut(), 0x2 | 0x4) } < 0 {
                    return Err("파일 선택 창을 초기화할 수 없습니다.".into());
                }
                let _apartment = Apartment;
                let mut file = vec![0u16; 32768];
                let filter: Vec<u16> = if compose {
                    "Compose (*.yaml;*.yml)\0*.yaml;*.yml\0\0"
                } else {
                    "Dockerfile\0Dockerfile*;*.dockerfile\0All files\0*.*\0\0"
                }
                .encode_utf16()
                .collect();
                let title: Vec<u16> = if compose {
                    "빌드할 Compose 파일 선택\0"
                } else {
                    "빌드할 Dockerfile 선택\0"
                }
                .encode_utf16()
                .collect();
                let mut value: OpenFileName = unsafe { std::mem::zeroed() };
                value.size = std::mem::size_of::<OpenFileName>() as u32;
                value.filter = filter.as_ptr();
                value.filter_index = 1;
                value.file = file.as_mut_ptr();
                value.max_file = file.len() as u32;
                value.title = title.as_ptr();
                value.flags = 0x80000 | 0x800 | 0x8 | 0x1000;
                if unsafe { GetOpenFileNameW(&mut value) } == 0 {
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
