use crate::{
    cli_platform,
    docker::{self, Client},
    process, runtime,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU8, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

mod binds;
mod batch;
mod configuration;
mod receipts;

const SOURCE: &str = cli_platform::DESKTOP_SOURCE;
const SOURCE_QUERY_TIMEOUT: Duration = Duration::from_secs(120);
const TARGET_QUERY_TIMEOUT: Duration = Duration::from_secs(120);
const CREATE_TIMEOUT: Duration = Duration::from_secs(120);
const TTL: Duration = Duration::from_secs(120);
const COPY_TIMEOUT: Duration = Duration::from_secs(3600);
static PLAN: Mutex<Option<Plan>> = Mutex::new(None);
static JOB: Mutex<Option<Value>> = Mutex::new(None);
static OPERATION: AtomicU8 = AtomicU8::new(0);
const READING: u8 = 1;
const COPYING: u8 = 2;

#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Selection {
    images: Vec<String>,
    containers: Vec<String>,
    volumes: Vec<String>,
    #[serde(default)]
    stop_running: bool,
    #[serde(default)]
    start_after_import: bool,
}
struct Plan {
    token: String,
    created: Instant,
    selection: Selection,
    source: String,
    target: String,
    images: Vec<Value>,
    containers: Vec<Value>,
    volumes: Vec<Value>,
    networks: Vec<Value>,
    reused_networks: Vec<String>,
    reused_volumes: Vec<String>,
    binds: Vec<binds::Copy>,
    blocked: Vec<String>,
}
pub fn is_busy() -> bool {
    OPERATION.load(Ordering::Acquire) == COPYING
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
fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}
fn id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn image_id(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(id)
}
fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
fn array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}
fn nonempty(value: &Value) -> bool {
    value.as_array().is_some_and(|v| !v.is_empty())
        || value.as_object().is_some_and(|v| !v.is_empty())
}

fn cli() -> Result<PathBuf, String> {
    let path = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("앱 설치 경로를 확인할 수 없습니다.")?
        .join("bin/docker.exe");
    if !path.is_file() {
        return Err(
            "같은 설치의 bin/docker.exe가 없습니다. 전체 설치 파일 또는 ZIP을 사용하세요.".into(),
        );
    }
    Ok(path)
}
fn command(host: &str, args: &[String], timeout: Duration) -> Result<Vec<u8>, String> {
    command_result(host, args, timeout).map_err(batch::ReadError::message)
}
fn command_result(host: &str, args: &[String], timeout: Duration) -> Result<Vec<u8>, batch::ReadError> {
    let mut arguments = vec!["--host".into(), host.into()];
    arguments.extend_from_slice(args);
    let output = process::execute(&cli().map_err(batch::ReadError::Other)?, &arguments, None, timeout, 16 * 1024 * 1024)
        .map_err(|error| {
            let message = command_error(host, args, timeout, &error);
            if error == "명령 응답 시간이 초과되었습니다" { batch::ReadError::Timeout(message) }
            else { batch::ReadError::Other(message) }
        })?;
    if !output.status.success() {
        return Err(batch::ReadError::Other(command_error(host, args, timeout, &command_exit_error(output.status.code().unwrap_or(-1), &output.stderr))));
    }
    Ok(output.stdout)
}
fn command_exit_error(code: i32, stderr: &[u8]) -> String {
    format!("명령이 실패했습니다 (종료 {code}). {}", daemon_error_reason(stderr))
}
fn daemon_error_reason(stderr: &[u8]) -> &'static str {
    let message = String::from_utf8_lossy(&stderr[..stderr.len().min(8192)]).to_ascii_lowercase();
    if message.contains("no such image") || message.contains("unable to find image") {
        "임시 복사 컨테이너에 사용할 이미지가 없습니다. 원본 이미지 목록을 다시 확인하세요."
    } else if message.contains("invalid mount") || message.contains("invalid volume specification") {
        "볼륨·마운트 설정을 Docker 엔진이 거부했습니다. 선택한 컨테이너의 연결 설정을 확인하세요."
    } else if message.contains("no space left") || message.contains("not enough space") {
        "엔진 저장 공간이 부족합니다. 해당 엔진과 Windows 디스크의 여유 공간을 확인하세요."
    } else if message.contains("permission denied") || message.contains("access is denied") {
        "엔진 또는 파일의 접근 권한이 부족합니다. Docker Desktop의 공유·보안 설정을 확인하세요."
    } else if message.contains("read-only file system") {
        "엔진 파일 시스템이 읽기 전용입니다. 원본과 대상 엔진의 저장소 상태를 확인하세요."
    } else if message.contains("cannot connect") || message.contains("connection refused") {
        "엔진 연결을 확인할 수 없습니다. 해당 엔진이 실행 중인지 확인하세요."
    } else {
        "엔진의 진단 로그에서 같은 시각의 실패 원인을 확인하세요. 원본 명령 출력은 비밀 값 보호를 위해 표시하지 않습니다."
    }
}
fn command_error(host: &str, args: &[String], timeout: Duration, error: &str) -> String {
    let engine = if host == SOURCE { "Docker Desktop" } else { "DockSlate" };
    let operation = args.first().filter(|value| ["info","container","image","volume","network"].contains(&value.as_str())).map(String::as_str).unwrap_or("Docker");
    let action = args.get(1).filter(|value| ["ls","inspect","create","stop","rm","save","load","tag","start","import"].contains(&value.as_str())).map(String::as_str).unwrap_or("");
    if error == "명령 응답 시간이 초과되었습니다" {
        format!("{engine} · {operation} {action}: 명령 응답 시간이 초과되었습니다 ({}초). 엔진의 실행 상태를 확인한 뒤 다시 조회하세요. 진행 중인 이전은 중지한 원본과 일부 복사본을 먼저 확인하세요.", timeout.as_secs())
    } else {
        format!("{engine} · {operation} {action}: {error}")
    }
}
fn query(host: &str, args: &[&str]) -> Result<Value, String> {
    serde_json::from_slice(&command(
        host,
        &args.iter().map(|v| (*v).into()).collect::<Vec<_>>(),
        if host == SOURCE { SOURCE_QUERY_TIMEOUT } else { TARGET_QUERY_TIMEOUT },
    )?)
    .map_err(|_| "Docker 응답을 읽을 수 없습니다.".into())
}
fn inspect(host: &str, kind: &str, value: &str) -> Result<Value, String> {
    if host != SOURCE {
        return inspect_owned(&target_client()?, kind, value);
    }
    Ok(inspect_many(host, kind, &[value.into()])?.remove(0))
}
fn owned_inspection_path(kind: &str, value: &str) -> Result<String, String> {
    if (kind == "image" && image_id(value)) || (["container", "volume", "network"].contains(&kind) && name(value)) {
        let suffix = if ["image", "container"].contains(&kind) { "/json" } else { "" };
        Ok(format!("/{kind}s/{}{suffix}", crate::resources::encode(value)))
    } else {
        Err("DockSlate 검사 대상의 종류 또는 ID가 올바르지 않습니다.".into())
    }
}
fn inspect_owned(target: &Client, kind: &str, value: &str) -> Result<Value, String> {
    let path = owned_inspection_path(kind, value)?;
    let bytes = target.bytes("GET", &path, TARGET_QUERY_TIMEOUT, 16 * 1024 * 1024)
        .map_err(|error| command_error("owned", &[kind.into(), "inspect".into()], TARGET_QUERY_TIMEOUT, &error))?;
    serde_json::from_slice(&bytes).map_err(|_| "DockSlate 검사 응답을 읽을 수 없습니다.".into())
}
fn inspect_many(host: &str, kind: &str, values: &[String]) -> Result<Vec<Value>, String> {
    inspect_projected(host, kind, values, None)
}
fn inspect_projected(host: &str, kind: &str, values: &[String], projection: Option<&str>) -> Result<Vec<Value>, String> {
    if values.is_empty() {
        return Ok(vec![]);
    }
    if values.len() > 4096
        || values.iter().any(|value| !match kind {
            "container" => id(value),
            "image" => image_id(value),
            "volume" | "network" => name(value),
            _ => false,
        })
    {
        return Err("Docker 검사 종류·ID·이름이 올바르지 않습니다.".into());
    }
    let mut completed = 0;
    batch::inspect(values, |chunk| {
        let mut args = vec![kind.into(), "inspect".into()];
        if let Some(format) = projection { args.extend(["--format".into(), format.into()]); }
        args.extend_from_slice(chunk);
        let output = command_result(host, &args, if host == SOURCE { SOURCE_QUERY_TIMEOUT } else { TARGET_QUERY_TIMEOUT })?;
        let rows: Vec<Value> = if projection.is_some() {
            std::str::from_utf8(&output).map_err(|_| batch::ReadError::Other("Docker 검사 응답 인코딩이 올바르지 않습니다.".into()))?
                .lines().filter(|line| !line.trim().is_empty()).map(serde_json::from_str)
                .collect::<Result<_, _>>().map_err(|_| batch::ReadError::Other("Docker 검사 응답을 읽을 수 없습니다.".into()))?
        } else {
            serde_json::from_slice(&output).map_err(|_| batch::ReadError::Other("Docker 검사 응답이 배열이 아닙니다.".into()))?
        };
        if rows.len() == chunk.len() { completed += rows.len(); inspection_progress(kind, completed, values.len()); }
        Ok(rows)
    })
}
fn lines(kind: &str, extra: &[&str]) -> Result<Vec<Value>, String> {
    let mut args = vec![kind.into(), "ls".into()];
    args.extend(extra.iter().map(|v| (*v).into()));
    args.extend(["--format".into(), "{{json .}}".into()]);
    let output = command(SOURCE, &args, SOURCE_QUERY_TIMEOUT)?;
    std::str::from_utf8(&output)
        .map_err(|_| "Docker 목록의 인코딩이 올바르지 않습니다.")?
        .lines()
        .filter(|v| !v.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line).map_err(|_| "Docker 목록을 해석할 수 없습니다.".into())
        })
        .collect()
}
fn inspection_progress(kind: &str, completed: usize, total: usize) {
    if let Ok(mut state) = JOB.lock() {
        if let Some(job) = state.as_mut().filter(|job| job["state"] == "running") {
            job["progress"] = json!({"phase":kind,"completed":completed,"total":total});
        }
    }
}
fn source_identity() -> Result<String, String> {
    let info = query(SOURCE, &["info", "--format", "{{json .}}"])?;
    source_info_identity(&info)
}
fn source_info_identity(info: &Value) -> Result<String, String> {
    match text(info, "OSType") {
        "linux" => {},
        "windows" => return Err("Docker Desktop이 Windows 컨테이너 모드입니다. Linux 컨테이너로 전환한 뒤 다시 조회하세요.".into()),
        _ => return Err("Docker Desktop 응답에서 컨테이너 운영체제를 확인하지 못했습니다. Docker Desktop의 실행 상태를 확인한 뒤 다시 조회하세요.".into()),
    }
    let identity = text(info, "ID");
    if identity.trim().is_empty() {
        return Err("Docker Desktop 응답에 엔진 ID가 없습니다. 엔진이 준비된 뒤 다시 조회하세요.".into());
    }
    Ok(identity.into())
}
fn target_client() -> Result<Client, String> {
    update("DockSlate 엔진 연결을 확인하고 있습니다.".into(), None, false);
    docker::connected().map_err(|error| format!("DockSlate 엔진 연결 확인: {error}"))
}
fn read_inventory() -> Result<Value, String> {
    let target = target_client()?;
    update("Docker Desktop 엔진을 확인하고 있습니다.".into(), None, false);
    let source = source_identity()?;
    if source == target.identity {
        return Err("원본과 대상 엔진이 같습니다.".into());
    }
    update("프로젝트의 컨테이너를 확인하고 있습니다.".into(), None, false);
    let containers = source_users()?;
    update("프로젝트의 이미지를 확인하고 있습니다.".into(), None, false);
    let images = lines("image", &["--no-trunc"])?;
    update("프로젝트의 볼륨을 확인하고 있습니다.".into(), None, false);
    let volume_names: Vec<_> = lines("volume", &[])?.iter().map(|value| text(value, "Name").to_owned()).collect();
    let volumes = inspect_many(SOURCE, "volume", &volume_names)?;
    let completed = receipts::read()?;
    let (target_images, target_containers, target_volumes) = thread::scope(|scope| {
        let images = scope.spawn(|| target.json("GET", "/images/json?all=1"));
        let containers = scope.spawn(|| target.containers());
        let volumes = target.json("GET", "/volumes");
        (images.join().unwrap_or_else(|_| Err("대상 이미지 조회를 완료하지 못했습니다.".into())), containers.join().unwrap_or_else(|_| Err("대상 컨테이너 조회를 완료하지 못했습니다.".into())), volumes)
    });
    let (target_images, target_containers, target_volumes) = (array(&target_images?), target_containers?, array(&target_volumes?["Volumes"]));
    let images: Vec<_> = images.into_iter().filter(|image| !target_images.iter().any(|existing| existing["Id"] == image["ID"] && strings(&existing["RepoTags"]).contains(&format!("{}:{}", text(image,"Repository"), text(image,"Tag"))))).collect();
    let containers: Vec<_> = containers.into_iter().filter(|value| receipts::find(&completed, &source, &target.identity, "containers", text(value,"Id"), value, &target_containers).is_none()).collect();
    let volumes: Vec<_> = volumes.into_iter().filter(|value| receipts::find(&completed, &source, &target.identity, "volumes", text(value,"Name"), value, &target_volumes).is_none()).collect();
    Ok(json!({"sourceEngine":source,"targetEngine":target.identity,
        "images":images.iter().map(|v| json!({"id":v["ID"],"name":format!("{}:{}",text(v,"Repository"),text(v,"Tag")),"detail":v["Size"]})).collect::<Vec<_>>(),
        "containers":containers.iter().map(|v| json!({"id":v["Id"],"name":text(v,"Name").trim_start_matches('/'),"detail":v["State"]["Status"],"project":v["Project"],"image":v["Image"],"volumes":array(&v["Mounts"]).iter().filter(|m| m["Type"]=="volume").map(|m|m["Name"].clone()).collect::<Vec<_>>()})).collect::<Vec<_>>(),
        "volumes":volumes.iter().map(|v| json!({"id":v["Name"],"name":v["Name"],"detail":v["Driver"],"project":v["Labels"]["com.docker.compose.project"]})).collect::<Vec<_>>() }))
}
pub fn inventory() -> Result<Value, String> {
    launch("inventory", runtime::new_token()?, READING, read_inventory)
}
pub fn compose_prepare(ids: Vec<String>) -> Result<Value, String> {
    configuration::prepare(ids)
}

fn selection_valid(selection: &Selection) -> bool {
    let count = selection.images.len() + selection.containers.len() + selection.volumes.len();
    let unique = |values: &[String]| {
        let mut ids = values.to_vec();
        ids.sort();
        ids.dedup();
        ids.len() == values.len()
    };
    (1..=4096).contains(&count)
        && unique(&selection.images)
        && unique(&selection.containers)
        && unique(&selection.volumes)
        && selection.images.iter().all(|v| image_id(v))
        && selection.containers.iter().all(|v| id(v))
        && selection.volumes.iter().all(|v| name(v))
}
fn container_blocked(source: &Value) -> Option<&'static str> {
    let host = &source["HostConfig"];
    if !["created", "exited", "running"].contains(&text(&source["State"], "Status")) {
        return Some("일시 정지·재시작 중인 컨테이너는 실행 또는 중지 상태로 바꾼 뒤 이전하세요.");
    }
    if host["Privileged"] == true
        || host["AutoRemove"] == true
        || host["PublishAllPorts"] == true
        || [
            "Devices",
            "DeviceRequests",
            "CapAdd",
            "VolumesFrom",
            "Links",
        ]
        .iter()
        .any(|k| nonempty(&host[*k]))
        || [
            "PidMode",
            "IpcMode",
            "UTSMode",
            "UsernsMode",
            "NetworkMode",
            "CgroupnsMode",
        ]
        .iter()
        .any(|k| {
            let v = text(host, k);
            v == "host" || v.starts_with("container:")
        })
        || strings(&host["SecurityOpt"])
            .iter()
            .any(|v| v != "no-new-privileges:true" && v != "no-new-privileges")
        || !["", "runc"].contains(&text(host, "Runtime"))
    {
        return Some("특권·장치·공유 네임스페이스·사용자 보안 프로필은 자동 이전할 수 없습니다.");
    }
    if source["Config"]["Labels"]
        .as_object()
        .is_some_and(|v| v.keys().any(|k| k.starts_with("com.docker.swarm.")))
    {
        return Some("Swarm 컨테이너는 자동 이전할 수 없습니다.");
    }
    for mount in array(&source["Mounts"]) {
        if !["volume", "tmpfs", "bind"].contains(&text(&mount, "Type")) {
            return Some("이 종류의 파일 연결은 자동 이전할 수 없습니다.");
        }
        if mount["Type"] == "bind" && !binds::valid(&mount) {
            return Some("폴더 연결 경로 또는 bind propagation을 지원하지 않습니다.");
        }
    }
    if source["NetworkSettings"]["Networks"]
        .as_object()
        .into_iter()
        .flatten()
        .any(|(_, v)| nonempty(&v["IPAMConfig"]) || nonempty(&v["DriverOpts"]))
    {
        return Some("고정 IP·사용자 endpoint 옵션은 자동 이전할 수 없습니다.");
    }
    None
}
fn fingerprint(container: &Value) -> Value {
    let state = &container["State"];
    json!({"Id":container["Id"],"Name":container["Name"],"Image":container["Image"],"Config":container["Config"],"HostConfig":container["HostConfig"],"Mounts":container["Mounts"],"State":{"Status":state["Status"],"StartedAt":state["StartedAt"],"FinishedAt":state["FinishedAt"]},"Networks":container["NetworkSettings"]["Networks"]})
}
fn stopped(value: &Value) -> bool {
    ["created", "exited"].contains(&text(&value["State"], "Status"))
}
fn same_configuration(before: &Value, after: &Value) -> bool {
    ["Id", "Name", "Image", "Config", "HostConfig", "Mounts"]
        .iter()
        .all(|key| before[*key] == after[*key])
}
fn start_order(containers: &[Value]) -> Result<Vec<String>, String> {
    let mut pending: Vec<_> = containers.iter().filter(|v| !stopped(v)).collect();
    let mut names = Vec::new();
    while !pending.is_empty() {
        let next=pending.iter().position(|value| {
            let labels=&value["Config"]["Labels"];
            !text(labels,"com.docker.compose.depends_on").split(',').filter(|v| !v.is_empty()).any(|entry| {
                let service=entry.split(':').next().unwrap();
                pending.iter().any(|dependency| text(&dependency["Config"]["Labels"],"com.docker.compose.project") == text(labels,"com.docker.compose.project") &&
                    text(&dependency["Config"]["Labels"],"com.docker.compose.service") == service)
            })
        }).ok_or("Compose 실행 순서에 순환 참조가 있습니다. 자동 시작을 해제하고 이전 후 직접 시작하세요.")?;
        names.push(
            text(pending.remove(next), "Name")
                .trim_start_matches('/')
                .to_owned(),
        );
    }
    Ok(names)
}
fn reusable_network(source: &Value, target: &Value) -> bool {
    !text(&target["Labels"], "io.dockslate.migration").is_empty()
        && [
            "Name",
            "Driver",
            "Internal",
            "Attachable",
            "EnableIPv6",
            "IPAM",
            "Options",
        ]
        .iter()
        .all(|key| source[*key] == target[*key])
        && source["EnableIPv4"].as_bool().unwrap_or(true)
            == target["EnableIPv4"].as_bool().unwrap_or(true)
        && source["Labels"].as_object().cloned().unwrap_or_default()
            == target["Labels"]
                .as_object()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|(key, _)| key != "io.dockslate.migration")
                .collect::<Map<_, _>>()
}
fn source_users() -> Result<Vec<Value>, String> {
    let rows = lines("container", &["--all", "--no-trunc"])?;
    let ids: Vec<_> = rows.iter().map(|v| text(v, "ID").to_owned()).collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    if ids.len() > 4096 || ids.iter().any(|v| !id(v)) {
        return Err("원본 컨테이너 목록이 너무 크거나 ID가 올바르지 않습니다.".into());
    }
    inspect_projected(SOURCE, "container", &ids, Some(r#"{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"Project":{{if .Config.Labels}}{{json (index .Config.Labels "com.docker.compose.project")}}{{else}}null{{end}},"State":{"Status":{{json .State.Status}},"StartedAt":{{json .State.StartedAt}},"FinishedAt":{{json .State.FinishedAt}}},"Mounts":{{json .Mounts}}}"#))
}
fn volume_references(name: &str) -> Result<Vec<Value>, String> {
    let filter = format!("volume={name}");
    let output = command(
        SOURCE,
        &[
            "container".into(),
            "ls".into(),
            "--all".into(),
            "--no-trunc".into(),
            "--filter".into(),
            filter,
            "--format".into(),
            "{{.ID}}".into(),
        ],
        SOURCE_QUERY_TIMEOUT,
    )?;
    let ids: Vec<String> = std::str::from_utf8(&output)
        .map_err(|_| "볼륨 참조 응답이 올바르지 않습니다.")?
        .lines()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect();
    if ids.iter().any(|v| !id(v)) {
        return Err("볼륨 참조 ID가 올바르지 않습니다.".into());
    }
    if ids.is_empty() {
        return Ok(vec![]);
    }
    inspect_projected(SOURCE, "container", &ids, Some(r#"{"Id":{{json .Id}},"State":{"Status":{{json .State.Status}},"StartedAt":{{json .State.StartedAt}},"FinishedAt":{{json .State.FinishedAt}}}}"#))
}
fn make_plan(selection: Selection, token: String, target: &Client) -> Result<Plan, String> {
    if !selection_valid(&selection) {
        return Err(
            "이미지·컨테이너·볼륨을 1~4096개 선택하세요. 올바른 ID와 이름이 필요합니다.".into(),
        );
    }
    let source = source_identity()?;
    if source == target.identity {
        return Err("원본과 대상 엔진이 같습니다.".into());
    }
    let mut plan = Plan {
        token,
        created: Instant::now(),
        selection: selection.clone(),
        source,
        target: target.identity.clone(),
        images: vec![],
        containers: vec![],
        volumes: vec![],
        networks: vec![],
        reused_networks: vec![],
        reused_volumes: vec![],
        binds: vec![],
        blocked: vec![],
    };
    let mut image_ids = selection.images;
    let mut volume_names = selection.volumes;
    let mut network_names = Vec::new();
    let completed = receipts::read()?;
    let target_containers = target.containers()?;
    let containers = inspect_many(SOURCE, "container", &selection.containers)?;
    for (selected, container) in selection.containers.into_iter().zip(containers) {
        if text(&container, "Id") != selected {
            return Err("원본 컨테이너 ID가 변경되었습니다.".into());
        }
        if receipts::find(&completed, &plan.source, &plan.target, "containers", &selected, &container, &target_containers).is_some() {
            return Err("이미 가져온 컨테이너입니다. 목록을 다시 조회하세요.".into());
        }
        let container_name = text(&container, "Name").trim_start_matches('/');
        if !name(container_name) {
            plan.blocked
                .push("지원하지 않는 원본 컨테이너 이름입니다.".into());
        }
        if let Some(reason) = container_blocked(&container) {
            plan.blocked.push(format!("{container_name}: {reason}"));
        }
        if !stopped(&container) && !plan.selection.stop_running {
            plan.blocked.push(format!(
                "{container_name}: 실행 중인 원본 정상 중지를 선택하세요."
            ));
        }
        if !stopped(&container)
            && ["SIGKILL", "KILL", "9"].contains(
                &text(&container["Config"], "StopSignal")
                    .to_ascii_uppercase()
                    .as_str(),
            )
        {
            plan.blocked.push(format!("{container_name}: 정상 종료 신호가 강제 종료로 설정되어 있습니다. 먼저 정상 중지하세요."));
        }
        if target_containers
            .iter()
            .any(|v| strings(&v["Names"]).contains(&format!("/{container_name}")))
        {
            plan.blocked.push(format!(
                "{container_name}: DockSlate에 같은 컨테이너 이름이 있습니다."
            ));
        }
        image_ids.push(text(&container, "Image").into());
        for mount in array(&container["Mounts"]) {
            if mount["Type"] == "volume" {
                volume_names.push(text(&mount, "Name").into());
            }
        }
        if let Some(networks) = container["NetworkSettings"]["Networks"].as_object() {
            network_names.extend(networks.keys().cloned());
        }
        plan.containers.push(container);
    }
    plan.binds = binds::plan(&plan.containers, &plan.token)?;
    if plan.selection.start_after_import {
        if let Err(reason) = start_order(&plan.containers) {
            plan.blocked.push(reason);
        }
    }
    if !volume_names.is_empty() && image_ids.is_empty() {
        let images = lines("image", &["--no-trunc"])?;
        image_ids.push(images.first().map(|v| text(v, "ID").to_owned()).ok_or(
            "볼륨 복사 도구로 사용할 원본 Linux 이미지가 없습니다. 원본에 이미지를 준비하세요.",
        )?);
    }
    image_ids.sort();
    image_ids.dedup();
    volume_names.sort();
    volume_names.dedup();
    network_names.sort();
    network_names.dedup();
    let target_images = array(&target.json("GET", "/images/json?all=1")?);
    let target_info = target.json("GET", "/info")?;
    let architecture = match text(&target_info, "Architecture") {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    let images = inspect_many(SOURCE, "image", &image_ids)?;
    for (value, image) in image_ids.into_iter().zip(images) {
        if !image_id(&value) {
            return Err("원본 이미지 ID가 올바르지 않습니다.".into());
        }
        if image["Os"] != "linux" || text(&image, "Id") != value {
            return Err("Linux 이미지 ID를 확인할 수 없습니다.".into());
        }
        if text(&image, "Architecture") != architecture {
            plan.blocked.push(format!(
                "{value}: 대상 엔진과 CPU 아키텍처가 다른 이미지는 자동 이전할 수 없습니다."
            ));
        }
        if !volume_names.is_empty() && plan.images.is_empty() {
            helper_args("preview", &image, &plan.token, true)?;
        }
        for tag in strings(&image["RepoTags"]) {
            if target_images
                .iter()
                .any(|v| v["Id"] != value && strings(&v["RepoTags"]).contains(&tag))
            {
                plan.blocked.push(format!(
                    "{tag}: DockSlate에 내용이 다른 이미지 태그가 있습니다."
                ));
            }
        }
        plan.images.push(image);
    }
    let target_volumes = target.json("GET", "/volumes")?;
    let target_volume_rows = array(&target_volumes["Volumes"]);
    for binding in &mut plan.binds {
        if let Some(receipt) = receipts::find(&completed, &plan.source, &plan.target, "binds", &binding.source, &Value::Null, &target_volume_rows) {
            binding.volume = receipt.destination.clone();
            plan.reused_volumes.push(binding.volume.clone());
        }
    }
    let users = if !volume_names.is_empty() || !plan.binds.is_empty() {
        source_users()?
    } else {
        vec![]
    };
    for user in &users {
        if !stopped(user)
            && !plan.containers.iter().any(|v| v["Id"] == user["Id"])
            && array(&user["Mounts"]).iter().any(|mount| {
                (mount["Type"] == "volume" && volume_names.iter().any(|v| mount["Name"] == *v))
                    || (mount["Type"] == "bind"
                        && plan
                            .binds
                            .iter()
                            .any(|v| binds::overlaps(&v.source, text(mount, "Source"))))
            })
        {
            plan.blocked.push(format!(
                "{}: 같은 데이터를 사용하는 컨테이너도 함께 선택하거나 먼저 정상 중지하세요.",
                text(user, "Name").trim_start_matches('/')
            ));
        }
    }
    for binding in &plan.binds {
        if !plan.reused_volumes.contains(&binding.volume) && target_volume_rows.iter().any(|v| v["Name"] == binding.volume)
        {
            plan.blocked.push(format!(
                "{}: 복사할 폴더 볼륨 이름이 이미 있습니다.",
                binding.volume
            ));
        }
    }
    let volumes = inspect_many(SOURCE, "volume", &volume_names)?;
    for (value, volume) in volume_names.into_iter().zip(volumes) {
        if !name(&value) {
            return Err("볼륨 이름이 올바르지 않습니다.".into());
        }
        if volume["Driver"] != "local" || nonempty(&volume["Options"]) {
            plan.blocked.push(format!(
                "{value}: 옵션 없는 local 볼륨만 자동 이전할 수 있습니다."
            ));
        }
        if receipts::find(&completed, &plan.source, &plan.target, "volumes", &value, &volume, &target_volume_rows).is_some() {
            plan.reused_volumes.push(value.clone());
        } else if target_volume_rows.iter().any(|v| v["Name"] == value) {
            plan.blocked
                .push(format!("{value}: DockSlate에 같은 볼륨 이름이 있습니다."));
        }
        plan.volumes.push(volume);
    }
    let target_networks = array(&target.json("GET", "/networks")?);
    for value in network_names {
        if ["bridge", "none"].contains(&value.as_str()) {
            continue;
        }
        if !name(&value) {
            return Err("네트워크 이름이 올바르지 않습니다.".into());
        }
        let network = inspect(SOURCE, "network", &value)?;
        if network["Driver"] != "bridge"
            || network["Scope"] != "local"
            || network["Ingress"] == true
            || network["ConfigOnly"] == true
            || text(&network["IPAM"], "Driver") != "default"
            || nonempty(&network["IPAM"]["Options"])
            || network["Options"]
                .get("com.docker.network.bridge.name")
                .is_some()
        {
            plan.blocked.push(format!(
                "{value}: 일반 local bridge 네트워크만 자동 이전할 수 있습니다."
            ));
        }
        if let Some(existing) = target_networks.iter().find(|v| v["Name"] == value) {
            if reusable_network(&network, existing) {
                plan.reused_networks.push(value.clone());
            } else {
                plan.blocked.push(format!("{value}: DockSlate에 설정이 다르거나 이전 이력을 확인할 수 없는 같은 네트워크가 있습니다."));
            }
        }
        plan.networks.push(network);
    }
    plan.created = Instant::now();
    Ok(plan)
}
fn public_plan(plan: &mut Plan) -> Value {
    plan.created = Instant::now();
    json!({"token":plan.token,"expiresAt":now()+TTL.as_millis() as u64,"eligible":plan.blocked.is_empty(),"blockedReasons":plan.blocked,
        "sourceEngine":plan.source,"targetEngine":plan.target,"images":plan.images.iter().map(|v| text(v,"Id")).collect::<Vec<_>>(),
        "containers":plan.containers.iter().map(|v| text(v,"Name").trim_start_matches('/')).collect::<Vec<_>>(),
        "volumes":plan.volumes.iter().map(|v| text(v,"Name")).collect::<Vec<_>>(),"networks":plan.networks.iter().map(|v| text(v,"Name")).collect::<Vec<_>>(),
        "stopContainers":plan.containers.iter().filter(|v| !stopped(v)).map(|v| text(v,"Name").trim_start_matches('/')).collect::<Vec<_>>(),
        "startContainers":if plan.selection.start_after_import { start_order(&plan.containers).unwrap_or_default() } else { vec![] },
        "binds":plan.binds.iter().map(|v| json!({"source":v.source,"volume":v.volume})).collect::<Vec<_>>(),
        "dockerSocketContainers":plan.containers.iter().filter(|v| array(&v["Mounts"]).iter().any(binds::socket)).map(|v| text(v,"Name").trim_start_matches('/')).collect::<Vec<_>>(),"reusedNetworks":plan.reused_networks,"reusedVolumes":plan.reused_volumes})
}
pub fn preview(selection: Selection) -> Result<Value, String> {
    if !selection_valid(&selection) { return Err("올바른 가져오기 대상을 1~4096개 선택하세요.".into()); }
    let token = runtime::new_token()?;
    launch("preview", token.clone(), READING, move || {
        let mut plan = make_plan(selection, token, &target_client()?)?;
        let value = public_plan(&mut plan);
        *PLAN.lock().map_err(|_| "가져오기 승인 정보를 보관할 수 없습니다.")? = if plan.blocked.is_empty() { Some(plan) } else { None };
        Ok(value)
    })
}

fn launch<F>(kind: &'static str, token: String, operation: u8, work: F) -> Result<Value, String>
where F: FnOnce() -> Result<Value, String> + Send + 'static {
    OPERATION.compare_exchange(0, operation, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "다른 데이터 가져오기 작업이 진행 중입니다.")?;
    if operation == READING {
        match PLAN.lock() {
            Ok(mut plan) => *plan = None,
            Err(_) => { OPERATION.store(0, Ordering::Release); return Err("이전 승인 정보를 초기화할 수 없습니다.".into()); }
        }
    }
    let initial = json!({"id":token,"kind":kind,"state":"running","message":"작업을 준비하고 있습니다.","completed":[],"warnings":[],"stoppedSources":[],"startedTargets":[]});
    match JOB.lock() {
        Ok(mut job) => *job = Some(initial.clone()),
        Err(_) => { OPERATION.store(0, Ordering::Release); return Err("가져오기 상태를 보관할 수 없습니다.".into()); }
    }
    if let Err(error) = thread::Builder::new().name("dockslate-migration".into()).spawn(move || {
        let result = work();
        if let Ok(mut state) = JOB.lock() {
            if let Some(job) = state.as_mut() {
                job["state"] = json!(if result.is_ok() { "completed" } else { "failed" });
                job["message"] = json!(match (kind, result.is_ok()) {
                    ("inventory", true) => "프로젝트 목록을 확인했습니다.",
                    ("preview", true) => "가져올 대상 검사를 마쳤습니다.",
                    ("transfer", true) => "복사가 끝났습니다. 대상의 데이터와 실행 상태를 확인하세요. Docker Desktop은 확인을 마치기 전까지 제거하지 마세요.",
                    ("transfer", false) => "이전이 중단되었습니다. 복사본과 원본 데이터는 보존했습니다. 중지한 원본·시작한 복사본 목록을 확인하고 한쪽만 실행하세요.",
                    _ => "조회 또는 검사를 완료하지 못했습니다. 다시 시도하세요.",
                });
                match result { Ok(value) if kind != "transfer" => job[kind] = value, Err(error) => job["error"] = json!(error), _ => () }
            }
            OPERATION.store(0, Ordering::Release);
        } else { OPERATION.store(0, Ordering::Release); }
    }) {
        if let Ok(mut state) = JOB.lock() { if let Some(job) = state.as_mut() { job["state"] = json!("failed"); job["error"] = json!("작업 스레드를 시작하지 못했습니다."); } }
        OPERATION.store(0, Ordering::Release);
        return Err(format!("가져오기 작업을 시작하지 못했습니다: {error}"));
    }
    Ok(initial)
}

fn update(message: String, completed: Option<String>, warning: bool) {
    if let Ok(mut state) = JOB.lock() {
        if let Some(job) = state.as_mut() {
            job["message"] = json!(message);
            if let Some(value) = completed {
                job[if warning { "warnings" } else { "completed" }]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(value));
            }
        }
    }
}
pub fn status() -> Result<Value, String> {
    let mut state = JOB.lock().map_err(|_| "가져오기 상태를 읽을 수 없습니다.")?;
    let response = state.clone().unwrap_or(Value::Null);
    if let Some(job) = state.as_mut().filter(|job| job["state"] != "running") {
        if let Some(object) = job.as_object_mut() { object.remove("inventory"); object.remove("preview"); }
    }
    Ok(response)
}

fn snapshot(plan: &Plan) -> Value {
    json!({"source":plan.source,"target":plan.target,"images":plan.images,"containers":plan.containers.iter().map(fingerprint).collect::<Vec<_>>(),"volumes":plan.volumes,"networks":plan.networks,"binds":plan.binds,"reusedNetworks":plan.reused_networks,"reusedVolumes":plan.reused_volumes})
}
pub fn execute(token: String, approved: bool) -> Result<Value, String> {
    if !approved {
        return Err("데이터 복사를 명시적으로 승인하세요.".into());
    }
    let plan = PLAN
        .lock()
        .map_err(|_| "가져오기 승인 정보를 읽을 수 없습니다.")?
        .take()
        .ok_or("대상 검사를 먼저 실행하세요.")?;
    if token != plan.token || plan.created.elapsed() >= TTL {
        return Err("승인 정보가 만료되었거나 올바르지 않습니다. 다시 검사하세요.".into());
    }
    launch("transfer", plan.token.clone(), COPYING, move || {
        let target = target_client()?;
        update("승인한 대상의 변경 여부를 다시 확인하고 있습니다.".into(), None, false);
        let rechecked = make_plan(plan.selection.clone(), plan.token.clone(), &target)?;
        if !rechecked.blocked.is_empty() || snapshot(&rechecked) != snapshot(&plan) {
            return Err("원본·대상·설정이 검사 후 변경되었습니다. 다시 검사하세요.".into());
        }
        transfer(rechecked, &target)?;
        Ok(Value::Null)
    })
}

struct Workspace {
    root: PathBuf,
    files: Vec<PathBuf>,
}
impl Workspace {
    fn new(token: &str) -> Result<Self, String> {
        let root = receipts::directory()?.join(token);
        fs::create_dir(&root).map_err(|_| "새 가져오기 임시 폴더를 만들 수 없습니다.")?;
        Ok(Self {
            root,
            files: Vec::new(),
        })
    }
    fn archive(&mut self) -> Result<(PathBuf, File), String> {
        let path = self.root.join(format!("{}.tar", self.files.len()));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| "새 복사 tar를 만들 수 없습니다.")?;
        self.files.push(path.clone());
        Ok((path, file))
    }
    fn remove(&self, path: &Path) -> Result<(), String> {
        fs::remove_file(path).map_err(|_| "임시 tar를 삭제하지 못했습니다.".into())
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        for file in &self.files {
            if file.exists() && fs::remove_file(file).is_err() {
                update(
                    "임시 파일 정리 확인이 필요합니다.".into(),
                    Some(format!("임시 tar 정리 실패: {}", file.display())),
                    true,
                );
            }
        }
        if fs::remove_dir(&self.root).is_err() {
            update(
                "임시 폴더 정리 확인이 필요합니다.".into(),
                Some(format!("임시 폴더 확인: {}", self.root.display())),
                true,
            );
        }
    }
}
fn copy_file(host: &str, args: &[String], archive: &File, input: bool) -> Result<(), String> {
    let mut cmd = Command::new(cli()?);
    cmd.arg("--host").arg(host).args(args);
    copy_command(cmd, archive, input, COPY_TIMEOUT, 64 * 1024 * 1024 * 1024)
}
fn copy_command(
    mut cmd: Command,
    archive: &File,
    input: bool,
    timeout: Duration,
    max_bytes: u64,
) -> Result<(), String> {
    cmd.stderr(Stdio::null());
    let file = archive
        .try_clone()
        .map_err(|_| "복사 tar 핸들을 준비할 수 없습니다.")?;
    if input {
        cmd.stdin(Stdio::from(file)).stdout(Stdio::null());
    } else {
        cmd.stdin(Stdio::null()).stdout(Stdio::from(file));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|_| "Docker 파일 복사를 시작할 수 없습니다.")?;
    let started = Instant::now();
    loop {
        let length = archive.metadata().map(|v| v.len());
        if started.elapsed() >= timeout || length.is_err() || length.unwrap_or(u64::MAX) > max_bytes
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("tar 복사가 1시간·파일당 64 GiB 제한을 넘었거나 파일을 읽지 못했습니다. 대상에 일부 데이터가 남을 수 있습니다.".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() && archive.metadata().is_ok_and(|v| v.len() <= max_bytes)
                {
                    Ok(())
                } else {
                    Err("Docker tar 복사가 실패했거나 크기 제한을 넘었습니다. 원본 상태와 남은 저장 공간을 확인하세요.".into())
                }
            }
            Ok(None) => thread::sleep(Duration::from_millis(200)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Docker 복사 결과를 확인할 수 없습니다.".into());
            }
        }
    }
}
fn same_engines(plan: &Plan, target: &Client) -> Result<(), String> {
    if source_identity()? != plan.source || target.json("GET", "/info")?["ID"] != plan.target {
        return Err("원본 또는 대상 엔진 ID가 변경되었습니다. 복사를 중단합니다.".into());
    }
    Ok(())
}
fn record_state(key: &str, name: &str) {
    if let Ok(mut state) = JOB.lock() {
        if let Some(items) = state.as_mut().and_then(|job| job[key].as_array_mut()) {
            if !items.iter().any(|v| v == name) {
                items.push(json!(name));
            }
        }
    }
}
fn stop_sources(plan: &mut Plan, target: &Client) -> Result<(), String> {
    same_engines(plan, target)?;
    let ids: Vec<_> = plan
        .containers
        .iter()
        .map(|v| text(v, "Id").to_owned())
        .collect();
    let before = inspect_many(SOURCE, "container", &ids)?;
    if before.iter().map(fingerprint).collect::<Vec<_>>()
        != plan.containers.iter().map(fingerprint).collect::<Vec<_>>()
    {
        return Err("원본 컨테이너가 변경되어 중지하지 않았습니다. 다시 검사하세요.".into());
    }
    let running: Vec<_> = before.iter().filter(|v| !stopped(v)).collect();
    if running.is_empty() {
        return Ok(());
    }
    if !plan.selection.stop_running {
        return Err("실행 중인 원본 정상 중지를 승인하지 않았습니다.".into());
    }
    update(
        "선택한 원본 컨테이너의 정상 종료를 기다리고 있습니다. 강제 종료하지 않습니다.".into(),
        None,
        false,
    );
    for (index, container) in running.iter().enumerate() {
        let container_id = text(container, "Id");
        update(format!("원본 정상 중지 ({}/{}): {}", index + 1, running.len(), text(container, "Name").trim_start_matches('/')), None, false);
        inspection_progress("stop", index, running.len());
        let result = command(SOURCE, &["container".into(), "stop".into(), "--timeout=-1".into(), container_id.into()], Duration::from_secs(180));
        let current = inspect(SOURCE, "container", container_id)?;
        if stopped(&current) { record_state("stoppedSources", text(&current, "Name").trim_start_matches('/')); }
        result.map_err(|_| "정상 종료 대기 중 오류 또는 컨테이너당 3분 제한에 도달했습니다. 강제 종료하지 않았습니다. 원본 상태를 확인하고 다시 검사하세요.".to_owned())?;
        if !same_configuration(container, &current) || !stopped(&current) {
            return Err("원본의 정상 종료를 확인하지 못했거나 설정이 변경되었습니다. 컨테이너·볼륨 데이터 복사는 시작하지 않았습니다. 중지한 원본 목록을 확인하세요.".into());
        }
        inspection_progress("stop", index + 1, running.len());
    }
    let after = inspect_many(SOURCE, "container", &ids)?;
    if before.iter().zip(&after).any(|(previous,current)| !same_configuration(previous,current) || !stopped(current)) {
        return Err("원본 컨테이너의 중지 상태 또는 설정이 변경되어 복사를 시작하지 않았습니다.".into());
    }
    plan.containers = after;
    Ok(())
}
fn create_owned_volume(
    target: &Client,
    volume_name: &str,
    labels: &Value,
    token: &str,
) -> Result<(), String> {
    if array(&target.json("GET", "/volumes")?["Volumes"])
        .iter()
        .any(|v| v["Name"] == volume_name)
    {
        return Err(format!("{volume_name}: 대상 볼륨이 이미 있습니다."));
    }
    let body = json!({"Name":volume_name,"Driver":"local","Labels":owned_labels(labels,token)});
    let created: Value = serde_json::from_slice(&target.transport.create_volume(
        &target.api,
        &serde_json::to_vec(&body).unwrap(),
        Duration::from_secs(30),
        1024 * 1024,
    )?)
    .map_err(|_| "대상 볼륨 생성 결과를 읽지 못했습니다.")?;
    if created["Labels"]["io.dockslate.migration"] != token {
        return Err("대상 볼륨 소유권이 다릅니다. 파일을 쓰지 않았습니다.".into());
    }
    Ok(())
}
fn owned_labels(labels: &Value, token: &str) -> Value {
    let mut labels = labels.as_object().cloned().unwrap_or_default();
    labels.insert("io.dockslate.migration".into(), json!(token));
    json!(labels)
}
fn ensure_tags(target: &Client, image: &Value) -> Result<(), String> {
    let images = array(&target.json("GET", "/images/json?all=1")?);
    for tag in strings(&image["RepoTags"]) {
        if images
            .iter()
            .any(|v| v["Id"] != image["Id"] && strings(&v["RepoTags"]).contains(&tag))
        {
            return Err(format!("{tag}: 다른 이미지의 태그를 덮어쓸 수 없습니다."));
        }
    }
    Ok(())
}
fn helper_args(
    volume: &str,
    image: &Value,
    token: &str,
    read_only: bool,
) -> Result<Vec<String>, String> {
    let mut args = vec![
        "container".into(),
        "create".into(),
        "--network".into(),
        "none".into(),
        "--read-only".into(),
        "--label".into(),
        format!("io.dockslate.migration={token}"),
        "--entrypoint".into(),
        "/__dockslate_copy_only".into(),
    ];
    for (path, _) in image["Config"]["Volumes"].as_object().into_iter().flatten() {
        if !path.starts_with('/')
            || path == "/"
            || path.contains(',')
            || path == "/__dockslate_transfer"
            || path.starts_with("/__dockslate_transfer/")
        {
            return Err("복사 도구 이미지의 기본 볼륨 경로를 지원하지 않습니다.".into());
        }
        args.extend(["--mount".into(), format!("type=tmpfs,dst={path}")]);
    }
    args.extend([
        "--mount".into(),
        format!(
            "type=volume,src={volume},dst=/__dockslate_transfer,volume-nocopy{}",
            if read_only { ",readonly" } else { "" }
        ),
        text(image, "Id").into(),
    ]);
    Ok(args)
}
fn create_helper(
    host: &str,
    volume: &str,
    image: &Value,
    token: &str,
    read_only: bool,
) -> Result<String, String> {
    let result = command(
        host,
        &helper_args(volume, image, token, read_only)?,
        CREATE_TIMEOUT,
    )?;
    let value = std::str::from_utf8(&result)
        .map_err(|_| "임시 컨테이너 ID를 읽지 못했습니다.")?
        .trim();
    if !id(value) {
        return Err(
            "임시 컨테이너 생성 결과가 올바르지 않습니다. 원본·대상 목록을 확인하세요.".into(),
        );
    }
    Ok(value.into())
}
fn remove_helper(
    host: &str,
    helper: &str,
    token: &str,
    expected_engine: &str,
) -> Result<(), String> {
    if query(host, &["info", "--format", "{{json .}}"])?["ID"] != expected_engine {
        return Err(format!(
            "엔진 변경으로 임시 컨테이너 {helper} 정리를 중단했습니다."
        ));
    }
    let current = inspect(host, "container", helper)?;
    if current["Config"]["Labels"]["io.dockslate.migration"] != token
        || current["State"]["Status"] != "created"
    {
        return Err(format!(
            "임시 컨테이너 {helper}의 소유권·중지 상태를 확인하지 못했습니다."
        ));
    }
    command(
        host,
        &["container".into(), "rm".into(), helper.into()],
        Duration::from_secs(30),
    )?;
    Ok(())
}
fn configuration(
    source: &Value,
    rootfs_image: &str,
    token: &str,
    bindings: &[binds::Copy],
) -> Result<Value, String> {
    if let Some(reason) = container_blocked(source) {
        return Err(reason.into());
    }
    let mut body = source["Config"]
        .as_object()
        .cloned()
        .ok_or("컨테이너 설정이 없습니다.")?;
    body.insert("Image".into(), json!(rootfs_image));
    body.insert(
        "Labels".into(),
        owned_labels(&source["Config"]["Labels"], token),
    );
    let mut host = source["HostConfig"].clone();
    host["Binds"] = Value::Null;
    let mut mounts: Vec<_> = array(&source["HostConfig"]["Mounts"])
        .into_iter()
        .filter(|v| v["Type"] == "tmpfs")
        .collect();
    for mount in array(&source["Mounts"])
        .iter()
        .filter(|v| v["Type"] == "volume")
    {
        let mut options = json!({"NoCopy":true});
        if let Some(previous) = array(&source["HostConfig"]["Mounts"])
            .iter()
            .find(|v| v["Type"] == "volume" && v["Target"] == mount["Destination"])
        {
            if let Some(subpath) = previous["VolumeOptions"]["Subpath"]
                .as_str()
                .filter(|v| !v.is_empty())
            {
                options["Subpath"] = json!(subpath);
            }
        }
        mounts.push(json!({"Type":"volume","Source":mount["Name"],"Target":mount["Destination"],"ReadOnly":mount["RW"]==false,"VolumeOptions":options}));
    }
    for mount in array(&source["Mounts"])
        .iter()
        .filter(|v| v["Type"] == "bind")
    {
        mounts.push(binds::mount(mount, bindings)?);
    }
    host["Mounts"] = json!(mounts);
    body.insert("HostConfig".into(), host);
    let mut endpoints = Map::new();
    for (name, previous) in source["NetworkSettings"]["Networks"]
        .as_object()
        .into_iter()
        .flatten()
    {
        let aliases: Vec<_> = strings(&previous["Aliases"])
            .into_iter()
            .filter(|v| v != text(source, "Id") && !text(source, "Id").starts_with(v.as_str()))
            .collect();
        endpoints.insert(
            name.clone(),
            if ["bridge", "none"].contains(&name.as_str()) {
                json!({})
            } else {
                json!({"Aliases":aliases,"GwPriority":previous["GwPriority"].as_i64().unwrap_or(0)})
            },
        );
    }
    body.insert(
        "NetworkingConfig".into(),
        json!({"EndpointsConfig":endpoints}),
    );
    Ok(json!(body))
}
fn transfer(mut current: Plan, target: &Client) -> Result<(), String> {
    let plan = &mut current;
    let destination = cli_platform::endpoint()?;
    let mut workspace = Workspace::new(&plan.token)?;
    let total = plan.images.len() + plan.binds.len() + plan.volumes.len() + plan.containers.len();
    let mut copied = 0;
    inspection_progress("copy", copied, total);
    for image in &plan.images {
        same_engines(plan, target)?;
        let image_id = text(image, "Id");
        update(format!("이미지 복사: {image_id}"), None, false);
        let present = array(&target.json("GET", "/images/json?all=1")?).iter().any(|value| value["Id"] == image_id);
        if !present {
        let (path, archive) = workspace.archive()?;
        copy_file(
            SOURCE,
            &["image".into(), "save".into(), image_id.into()],
            &archive,
            false,
        )?;
        if inspect(SOURCE, "image", image_id)? != *image {
            return Err("복사 중 원본 이미지 태그·설정이 변경되었습니다.".into());
        }
        ensure_tags(target, image)?;
        command(
            &destination,
            &[
                "image".into(),
                "load".into(),
                "--input".into(),
                path.to_string_lossy().into_owned(),
            ],
            COPY_TIMEOUT,
        )?;
        if inspect_owned(target, "image", image_id)?["Id"] != image_id {
            return Err("대상 이미지 ID가 원본과 다릅니다. 결과를 확인하세요.".into());
        }
        drop(archive);
        workspace.remove(&path)?;
        }
        for tag in strings(&image["RepoTags"]) {
            ensure_tags(target, image)?;
            command(
                &destination,
                &[
                    "image".into(),
                    "tag".into(),
                    "--".into(),
                    image_id.into(),
                    tag,
                ],
                Duration::from_secs(30),
            )?;
        }
        if let Ok(mut state) = JOB.lock() { if let Some(job) = state.as_mut() { if !job["imported"].is_array() { job["imported"] = json!([]); } job["imported"].as_array_mut().unwrap().push(json!({"kind":"images","id":image_id})); } }
        copied += 1; inspection_progress("copy", copied, total);
        update(
            "이미지를 복사했습니다.".into(),
            Some(format!("이미지 {image_id}")),
            false,
        );
    }
    let start_names = if plan.selection.start_after_import {
        start_order(&plan.containers)?
    } else {
        vec![]
    };
    stop_sources(plan, target)?;
    for binding in &plan.binds {
        copied += 1; inspection_progress("copy", copied - 1, total);
        if plan.reused_volumes.contains(&binding.volume) { inspection_progress("copy", copied, total); continue; }
        binds::copy(plan, target, binding, &destination, &mut workspace)?;
        let destination_volume = target.json("GET", &format!("/volumes/{}", crate::resources::encode(&binding.volume)))?;
        receipts::save(plan, "binds", &binding.source, &Value::Null, &destination_volume)?;
        inspection_progress("copy", copied, total);
    }
    for volume in &plan.volumes {
        copied += 1; inspection_progress("copy", copied - 1, total);
        if plan.reused_volumes.iter().any(|value| volume["Name"] == *value) { inspection_progress("copy", copied, total); continue; }
        same_engines(plan, target)?;
        let volume_name = text(volume, "Name");
        update(format!("볼륨 복사: {volume_name}"), None, false);
        let before = volume_references(volume_name)?;
        if before
            .iter()
            .any(|v| !["created", "exited"].contains(&text(&v["State"], "Status")))
        {
            return Err(format!(
                "{volume_name}: 원본 볼륨이 실행 중인 컨테이너에 연결되었습니다."
            ));
        }
        let image = plan.images.first().ok_or("볼륨 복사 이미지가 없습니다.")?;
        let (path, archive) = workspace.archive()?;
        let source_helper = create_helper(SOURCE, volume_name, image, &plan.token, true)?;
        let mut target_helper = None;
        let result: Result<(), String> = (|| {
            copy_file(
                SOURCE,
                &[
                    "container".into(),
                    "cp".into(),
                    "--archive".into(),
                    format!("{source_helper}:/__dockslate_transfer/."),
                    "-".into(),
                ],
                &archive,
                false,
            )?;
            let mut after = volume_references(volume_name)?;
            after.retain(|v| v["Id"] != source_helper);
            if before.iter().map(fingerprint).collect::<Vec<_>>()
                != after.iter().map(fingerprint).collect::<Vec<_>>()
            {
                return Err("볼륨 복사 중 원본 컨테이너 상태가 변경되었습니다.".into());
            }
            create_owned_volume(target, volume_name, &volume["Labels"], &plan.token)?;
            update(
                "새 볼륨에 데이터를 복사하고 있습니다.".into(),
                Some(format!("새 볼륨 {volume_name} (복사 중)")),
                false,
            );
            let helper = create_helper(&destination, volume_name, image, &plan.token, false)?;
            target_helper = Some(helper.clone());
            drop(archive);
            let input = File::open(&path).map_err(|_| "가져올 볼륨 tar를 열 수 없습니다.")?;
            copy_file(
                &destination,
                &[
                    "container".into(),
                    "cp".into(),
                    "--archive".into(),
                    "-".into(),
                    format!("{helper}:/__dockslate_transfer"),
                ],
                &input,
                true,
            )?;
            Ok(())
        })();
        for (host, helper, engine) in [
            (SOURCE, Some(source_helper), plan.source.as_str()),
            (destination.as_str(), target_helper, plan.target.as_str()),
        ] {
            if let Some(helper) = helper {
                if let Err(error) = remove_helper(host, &helper, &plan.token, engine) {
                    update("임시 컨테이너 정리를 확인하세요.".into(), Some(error), true);
                }
            }
        }
        result?;
        let destination_volume = target.json("GET", &format!("/volumes/{}", crate::resources::encode(volume_name)))?;
        receipts::save(plan, "volumes", volume_name, volume, &destination_volume)?;
        inspection_progress("copy", copied, total);
        workspace.remove(&path)?;
        update(
            "볼륨을 복사했습니다.".into(),
            Some(format!("볼륨 {volume_name}")),
            false,
        );
    }
    for network in &plan.networks {
        same_engines(plan, target)?;
        let network_name = text(network, "Name");
        if plan.reused_networks.iter().any(|v| v == network_name) {
            let networks = array(&target.json("GET", "/networks")?);
            if !networks.iter().any(|v| reusable_network(network, v)) {
                return Err(format!(
                    "{network_name}: 재사용할 네트워크 설정이 변경되었습니다."
                ));
            }
            update(
                "기존에 이전한 네트워크를 사용합니다.".into(),
                Some(format!("기존 네트워크 {network_name}")),
                false,
            );
            continue;
        }
        let body = json!({"Name":network_name,"Driver":"bridge","CheckDuplicate":true,"Internal":network["Internal"],"Attachable":network["Attachable"],"EnableIPv4":network["EnableIPv4"].as_bool().unwrap_or(true),"EnableIPv6":network["EnableIPv6"],"IPAM":network["IPAM"],"Options":network["Options"],"Labels":owned_labels(&network["Labels"],&plan.token)});
        target
            .transport
            .create_network(
                &target.api,
                &serde_json::to_vec(&body).unwrap(),
                Duration::from_secs(30),
                1024 * 1024,
            )
            .map_err(|_| {
                format!(
                    "네트워크 {network_name} 생성에 실패했습니다. 이름·서브넷 충돌을 확인하세요."
                )
            })?;
        update(
            "네트워크를 복사했습니다.".into(),
            Some(format!("네트워크 {network_name}")),
            false,
        );
    }
    for source in &plan.containers {
        copied += 1; inspection_progress("copy", copied - 1, total);
        same_engines(plan, target)?;
        let container_id = text(source, "Id");
        let container_name = text(source, "Name").trim_start_matches('/');
        update(format!("컨테이너 파일 복사: {container_name}"), None, false);
        if fingerprint(&inspect(SOURCE, "container", container_id)?) != fingerprint(source) {
            return Err(format!("{container_name}: 원본 컨테이너가 변경되었습니다."));
        }
        let (path, archive) = workspace.archive()?;
        copy_file(
            SOURCE,
            &["container".into(), "export".into(), container_id.into()],
            &archive,
            false,
        )?;
        if fingerprint(&inspect(SOURCE, "container", container_id)?) != fingerprint(source) {
            return Err(format!(
                "{container_name}: 파일 복사 중 원본이 변경되었습니다."
            ));
        }
        let imported = command(
            &destination,
            &[
                "image".into(),
                "import".into(),
                path.to_string_lossy().into_owned(),
            ],
            COPY_TIMEOUT,
        )?;
        let rootfs = std::str::from_utf8(&imported)
            .map_err(|_| "복사한 파일 이미지 ID를 읽지 못했습니다.")?
            .trim();
        if !image_id(rootfs) {
            return Err("컨테이너 쓰기 계층의 새 이미지 ID가 올바르지 않습니다.".into());
        }
        update(
            "컨테이너 파일을 보존했습니다.".into(),
            Some(format!("컨테이너 파일 이미지 {rootfs}")),
            false,
        );
        let body = configuration(source, rootfs, &plan.token, &plan.binds)?;
        let created: Value = serde_json::from_slice(&target.transport.create_container(&target.api,container_name,&serde_json::to_vec(&body).unwrap(),CREATE_TIMEOUT,1024*1024).map_err(|error| format!("{container_name}: 컨테이너 생성에 실패했습니다. 복사한 이미지·볼륨은 보존했습니다. {}", daemon_error_reason(error.as_bytes())))?).map_err(|_| "컨테이너 생성 결과를 읽지 못했습니다.")?;
        if !id(text(&created, "Id")) {
            return Err("대상 컨테이너 생성 결과를 확인하지 못했습니다.".into());
        }
        let destination_container = target.json("GET", &format!("/containers/{}/json", text(&created, "Id")))?;
        let mut receipt_container = destination_container.clone();
        receipt_container["Labels"] = destination_container["Config"]["Labels"].clone();
        receipts::save(plan, "containers", container_id, source, &receipt_container)?;
        inspection_progress("copy", copied, total);
        update(
            "중지 상태의 컨테이너를 만들었습니다.".into(),
            Some(format!(
                "컨테이너 {container_name} ({})",
                text(&created, "Id")
            )),
            false,
        );
        drop(archive);
        workspace.remove(&path)?;
    }
    if !start_names.is_empty() {
        let ids: Vec<_> = plan
            .containers
            .iter()
            .map(|v| text(v, "Id").to_owned())
            .collect();
        let originals = inspect_many(SOURCE, "container", &ids)?;
        if originals.iter().map(fingerprint).collect::<Vec<_>>()
            != plan.containers.iter().map(fingerprint).collect::<Vec<_>>()
        {
            return Err("원본 상태가 복사 후 변경되어 복사본을 시작하지 않았습니다. 양쪽 컨테이너 상태를 확인하세요.".into());
        }
    }
    let mut start_errors = Vec::new();
    for container_name in start_names {
        same_engines(plan, target)?;
        let value = inspect_owned(target, "container", &container_name)?;
        if value["Config"]["Labels"]["io.dockslate.migration"] != plan.token {
            return Err("복사본의 소유권이 변경되었습니다. 시작하지 않았습니다.".into());
        }
        match command(
            &destination,
            &["container".into(), "start".into(), text(&value, "Id").into()],
            Duration::from_secs(120),
        ) {
            Ok(_) => {
                record_state("startedTargets", &container_name);
                if inspect_owned(target, "container", text(&value, "Id"))?["State"]["Running"]
                    == true
                {
                    update(
                        "원래 실행 중이던 복사본을 시작했습니다.".into(),
                        Some(format!("시작 {container_name}")),
                        false,
                    );
                } else {
                    start_errors.push(container_name);
                }
            }
            Err(_) => start_errors.push(container_name),
        }
    }
    if !start_errors.is_empty() {
        return Err(format!("데이터 복사는 완료했지만 컨테이너 시작에 실패했습니다: {}. 포트·호스트 IP 충돌과 해당 컨테이너 로그를 확인하세요. 원본은 중지 상태로 보존했습니다.",start_errors.join(", ")));
    }
    Ok(())
}

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn desktop_source_identity_does_not_depend_on_operating_system_description() {
        for operating_system in [json!("Docker Desktop"), json!("Ubuntu 24.04.3 LTS"), json!(""), Value::Null] {
            let info = json!({"OSType":"linux", "ID":"source-engine-id", "OperatingSystem":operating_system});
            assert_eq!(source_info_identity(&info).unwrap(), "source-engine-id");
        }
    }

    #[test]
    fn desktop_source_identity_rejects_non_linux_and_missing_identity() {
        for os_type in [json!("windows"), json!(""), json!("darwin"), Value::Null] {
            assert!(source_info_identity(&json!({"OSType":os_type, "ID":"source-engine-id", "OperatingSystem":"Docker Desktop"})).is_err());
        }
        for identity in [json!(""), json!(" \t"), json!(42), Value::Null] {
            let error = source_info_identity(&json!({"OSType":"linux", "ID":identity, "OperatingSystem":"Docker Desktop"})).unwrap_err();
            assert!(error.contains("엔진 ID"));
        }
        assert!(source_info_identity(&json!({"OSType":"windows", "ID":"source-engine-id"})).unwrap_err().contains("Windows 컨테이너 모드"));
        assert!(source_info_identity(&json!({"ID":"source-engine-id"})).unwrap_err().contains("운영체제를 확인하지 못했습니다"));
    }

    #[test]
    fn owned_inspection_paths_accept_only_fixed_resources_and_encoded_identifiers() {
        let image = format!("sha256:{}", "a".repeat(64));
        assert_eq!(owned_inspection_path("image", &image).unwrap(), format!("/images/sha256%3A{}/json", "a".repeat(64)));
        assert_eq!(owned_inspection_path("container", "demo-database-1").unwrap(), "/containers/demo-database-1/json");
        assert_eq!(owned_inspection_path("volume", "demo-data").unwrap(), "/volumes/demo-data");
        for (kind, value) in [("image", "not-an-id"), ("container", "../other"), ("volume", "data?force=1"), ("container", "--host"), ("system", "info")] {
            assert!(owned_inspection_path(kind, value).is_err());
        }
    }

    #[test]
    fn migration_failure_diagnosis_identifies_common_causes_without_daemon_values() {
        for (stderr, expected) in [
            ("Error response from daemon: invalid mount config for type volume DB_PASSWORD=fixture-secret", "볼륨·마운트 설정"),
            ("No such image: private-registry/fixture-secret", "이미지가 없습니다"),
            ("write /fixture-secret: no space left on device", "저장 공간"),
            ("permission denied: fixture-secret", "접근 권한"),
        ] {
            let message = command_exit_error(1, stderr.as_bytes());
            assert!(message.contains(expected), "{message}");
            assert!(message.contains("종료 1"));
            assert!(!message.contains("fixture-secret") && !message.contains("DB_PASSWORD"));
        }
        let unknown = command_exit_error(17, b"unknown fixture-secret daemon detail");
        assert!(unknown.contains("종료 17") && !unknown.contains("fixture-secret"));
    }

    #[test]
    fn migration_timeout_identifies_engine_and_step_without_configuration_values() {
        let args = ["container", "inspect", "fixture-secret-value"].map(str::to_owned);
        let source = command_error(SOURCE, &args, SOURCE_QUERY_TIMEOUT, "명령 응답 시간이 초과되었습니다");
        assert!(source.contains("Docker Desktop · container inspect"));
        assert!(source.contains("120초"));
        assert!(!source.contains("fixture-secret-value"));
        let target = command_error("owned", &args, Duration::from_secs(30), "명령 응답 시간이 초과되었습니다");
        assert!(target.contains("DockSlate · container inspect"));
        let unknown = ["fixture-secret-value", "private-argument"].map(str::to_owned);
        let safe = command_error(SOURCE, &unknown, Duration::from_secs(30), "명령 응답 시간이 초과되었습니다");
        assert!(!safe.contains("fixture-secret-value") && !safe.contains("private-argument"));
    }
    fn source() -> Value {
        json!({"Id":"a".repeat(64),"Name":"/database","Image":format!("sha256:{}","b".repeat(64)),"State":{"Status":"exited","StartedAt":"before"},
            "Config":{"Env":["DB_PASSWORD=fixture-only"],"Cmd":["server"],"Entrypoint":["/entrypoint"],"Labels":{"com.docker.compose.project":"demo"}},
            "HostConfig":{"NetworkMode":"demo_default","PortBindings":{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"15432"}]},"RestartPolicy":{"Name":"unless-stopped"},"Binds":["database:/data"]},
            "Mounts":[{"Type":"volume","Name":"database","Destination":"/data","RW":true}],
            "NetworkSettings":{"Networks":{"demo_default":{"Aliases":["database","a".repeat(12)],"IPAMConfig":null}}}})
    }
    #[test]
    fn migration_status_transfers_read_results_without_retaining_a_result_cache() {
        *JOB.lock().unwrap() = Some(json!({"state":"completed","kind":"inventory","inventory":{"containers":[]},"message":"done"}));
        assert!(status().unwrap()["inventory"].is_object());
        let remaining = status().unwrap();
        assert!(remaining["inventory"].is_null());
        assert_eq!(remaining["message"], "done");
        *JOB.lock().unwrap() = None;
    }
    #[test]
    fn migration_selection_rejects_options_paths_and_excessive_work() {
        let mut selection = Selection {
            images: vec![format!("sha256:{}", "b".repeat(64))],
            containers: vec![],
            volumes: vec![],
            ..Selection::default()
        };
        assert!(selection_valid(&selection));
        selection.images.push(selection.images[0].clone());
        assert!(!selection_valid(&selection));
        selection.images.pop();
        selection.volumes = vec!["-option".into()];
        assert!(!selection_valid(&selection));
        selection.volumes = vec!["../file".into()];
        assert!(!selection_valid(&selection));
        selection.volumes = vec!["safe".into(); 128];
        assert!(!selection_valid(&selection));
        selection.volumes = (0..4096).map(|index| format!("volume-{index}")).collect();
        assert!(!selection_valid(&selection));
        selection.volumes.pop();
        assert!(selection_valid(&selection));
        selection.volumes.clear();
        selection.containers = vec!["not-a-full-id".into()];
        assert!(!selection_valid(&selection));
    }
    #[test]
    fn migration_inspection_rejects_invalid_arguments_before_launch() {
        for (kind, value) in [
            ("image", "--format"),
            ("container", "../container"),
            ("volume", "--config"),
            ("network", "bad/name"),
            ("unknown", "name"),
        ] {
            let error = inspect_many(SOURCE, kind, &[value.into()]).unwrap_err();
            assert!(
                error.contains("종류·ID·이름"),
                "Unexpected CLI access: {error}"
            );
        }
    }
    #[test]
    fn migration_running_and_file_binds_can_be_reviewed() {
        let mut container = source();
        container["State"]["Status"] = json!("running");
        assert!(container_blocked(&container).is_none());
        container["Mounts"] = json!([{"Type":"bind","Source":"/host_mnt/c/config/nginx.conf","Destination":"/etc/nginx/nginx.conf","RW":false,"Propagation":"rprivate"}]);
        assert!(container_blocked(&container).is_none());
    }
    #[test]
    fn migration_rejects_paused_containers_invalid_binds_devices_and_fixed_ips() {
        assert!(container_blocked(&source()).is_none());
        for (path, value) in [
            ("/State/Status", json!("paused")),
            ("/HostConfig/Privileged", json!(true)),
            ("/HostConfig/DeviceRequests", json!([{"Driver":"nvidia"}])),
            (
                "/Mounts",
                json!([{"Type":"bind","Source":"/host_mnt/c/data"}]),
            ),
            (
                "/NetworkSettings/Networks/demo_default/IPAMConfig",
                json!({"IPv4Address":"172.19.0.8"}),
            ),
        ] {
            let mut container = source();
            let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
            let mut slot = &mut container;
            for part in &parts {
                slot = &mut slot[*part];
            }
            *slot = value;
            assert!(container_blocked(&container).is_some(), "Accepted {path}");
        }
    }
    #[test]
    fn migration_preserves_configuration_and_prevents_volume_seeding() {
        let mut source = source();
        let body = configuration(&source, "sha256:new-snapshot", "job", &[]).unwrap();
        assert_eq!(body["Env"], source["Config"]["Env"]);
        assert_eq!(body["Entrypoint"], source["Config"]["Entrypoint"]);
        assert_eq!(
            body["HostConfig"]["PortBindings"],
            source["HostConfig"]["PortBindings"]
        );
        assert_eq!(
            body["HostConfig"]["RestartPolicy"],
            source["HostConfig"]["RestartPolicy"]
        );
        assert_eq!(
            body["HostConfig"]["Mounts"][0]["VolumeOptions"]["NoCopy"],
            true
        );
        assert!(body["HostConfig"]["Binds"].is_null());
        assert_eq!(
            body["NetworkingConfig"]["EndpointsConfig"]["demo_default"]["Aliases"],
            json!(["database"])
        );
        source["HostConfig"]["Mounts"] = json!([{"Type":"volume","Source":"database","Target":"/data","VolumeOptions":{"Subpath":"postgres","NoCopy":false}}]);
        let body = configuration(&source, "sha256:new-snapshot", "job", &[]).unwrap();
        assert_eq!(
            body["HostConfig"]["Mounts"][0]["VolumeOptions"],
            json!({"Subpath":"postgres","NoCopy":true})
        );
    }
    #[test]
    fn migration_tracks_stop_start_intent_without_health_log_churn() {
        let mut before = source();
        before["State"]["Status"] = json!("running");
        let mut after = before.clone();
        after["State"]["Health"] = json!({"Status":"healthy","Log":["changing"]});
        assert_eq!(fingerprint(&before), fingerprint(&after));
        after["State"]["Status"] = json!("exited");
        after["State"]["FinishedAt"] = json!("now");
        assert!(same_configuration(&before, &after));
        assert!(stopped(&after));
        assert_ne!(fingerprint(&before), fingerprint(&after));
        after["HostConfig"]["RestartPolicy"] = json!({"Name":"always"});
        assert!(!same_configuration(&before, &after));
        let old: Selection =
            serde_json::from_value(json!({"images":[],"containers":[],"volumes":[]})).unwrap();
        assert!(!old.stop_running && !old.start_after_import);
        let options: Selection=serde_json::from_value(json!({"images":[],"containers":[],"volumes":[],"stopRunning":true,"startAfterImport":true})).unwrap();
        assert!(options.stop_running && options.start_after_import);
    }
    #[test]
    fn migration_reuses_only_identical_previously_imported_networks() {
        let source = json!({"Name":"demo","Driver":"bridge","Internal":false,"Attachable":false,"EnableIPv6":false,"IPAM":{"Driver":"default"},"Options":{},"Labels":{"com.docker.compose.project":"demo"}});
        let mut target = source.clone();
        assert!(!reusable_network(&source, &target));
        target["Labels"]["io.dockslate.migration"] = json!("previous-copy");
        assert!(reusable_network(&source, &target));
        target["EnableIPv4"] = json!(false);
        assert!(!reusable_network(&source, &target));
        target["EnableIPv4"] = json!(true);
        target["IPAM"]["Driver"] = json!("other");
        assert!(!reusable_network(&source, &target));
    }
    #[test]
    fn migration_starts_dependencies_before_consumers_and_detects_cycles() {
        let container = |service: &str, depends: &str| json!({"Name":format!("/{service}"),"State":{"Status":"running"},"Config":{"Labels":{"com.docker.compose.project":"demo","com.docker.compose.service":service,"com.docker.compose.depends_on":depends}}});
        let values = vec![
            container("web", "db:service_healthy:false"),
            container("db", ""),
        ];
        assert_eq!(start_order(&values).unwrap(), vec!["db", "web"]);
        assert!(start_order(&[
            container("web", "db:service_started:false"),
            container("db", "web:service_started:false")
        ])
        .is_err());
        let mut exited = container("worker", "");
        exited["State"]["Status"] = json!("exited");
        assert_eq!(start_order(&[exited]).unwrap(), Vec::<String>::new());
    }
    #[test]
    fn migration_helpers_are_never_started_and_source_mount_is_read_only() {
        let image = json!({"Id":format!("sha256:{}","b".repeat(64)),"Config":{"Volumes":{"/var/lib/postgresql":{}}}});
        let source_args = helper_args("data", &image, "job", true).unwrap();
        assert_eq!(&source_args[..2], &["container", "create"]);
        assert!(source_args.contains(
            &"type=volume,src=data,dst=/__dockslate_transfer,volume-nocopy,readonly".into()
        ));
        assert!(source_args.contains(&"type=tmpfs,dst=/var/lib/postgresql".into()));
        assert!(!source_args
            .iter()
            .any(|v| v == "run" || v == "start" || v == "--privileged"));
    }
    #[test]
    fn migration_public_preview_never_returns_environment_values() {
        let mut container = source();
        let mut plan = Plan {
            token: "token".into(),
            created: Instant::now() - TTL,
            selection: Selection {
                images: vec![],
                containers: vec![],
                volumes: vec![],
                ..Selection::default()
            },
            source: "desktop".into(),
            target: "owned".into(),
            images: vec![],
            containers: vec![container.clone()],
            volumes: vec![],
            networks: vec![],
            reused_networks: vec![],
            reused_volumes: vec![],
            binds: vec![],
            blocked: vec![],
        };
        let public = public_plan(&mut plan).to_string();
        assert!(plan.created.elapsed() < TTL, "Inspection time must not consume the displayed approval window");
        assert!(public.contains("database"));
        assert!(!public.contains("fixture-only"));
        assert!(!public.contains("DB_PASSWORD"));
        let before = fingerprint(&container);
        container["State"]["StartedAt"] = json!("later");
        assert_ne!(before, fingerprint(&container));
    }
    #[test]
    fn migration_expired_approval_stops_before_engine_access() {
        *PLAN.lock().unwrap() = Some(Plan {
            token: "token".into(),
            created: Instant::now() - TTL,
            selection: Selection {
                images: vec![],
                containers: vec![],
                volumes: vec![],
                ..Selection::default()
            },
            source: "desktop".into(),
            target: "owned".into(),
            images: vec![],
            containers: vec![],
            volumes: vec![],
            networks: vec![],
            reused_networks: vec![],
            reused_volumes: vec![],
            binds: vec![],
            blocked: vec![],
        });
        assert!(execute("token".into(), true).unwrap_err().contains("만료"));
        assert!(PLAN.lock().unwrap().is_none());
        assert!(!is_busy());
    }
    #[cfg(windows)]
    #[test]
    fn migration_binary_copy_preserves_bytes_and_bounds_failures() {
        use std::io::{Read, Seek, SeekFrom, Write};
        fn powershell(script: &str) -> Command {
            let mut command = Command::new(
                runtime::system_directory()
                    .unwrap()
                    .join("WindowsPowerShell/v1.0/powershell.exe"),
            );
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ]);
            command
        }
        let token = runtime::new_token().unwrap();
        let mut workspace = Workspace::new(&token).unwrap();
        let (_, mut archive) = workspace.archive().unwrap();
        copy_command(
            powershell("[Console]::OpenStandardOutput().Write([byte[]](0,255,0,10,13,128),0,6)"),
            &archive,
            false,
            Duration::from_secs(10),
            64,
        )
        .unwrap();
        archive.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = vec![];
        archive.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, vec![0, 255, 0, 10, 13, 128]);
        archive.seek(SeekFrom::Start(0)).unwrap();
        copy_command(powershell("$b=New-Object byte[] 6; if ([Console]::OpenStandardInput().Read($b,0,6) -ne 6 -or $b[1] -ne 255) {exit 9}"),&archive,true,Duration::from_secs(10),64).unwrap();
        assert!(copy_command(
            powershell("exit 7"),
            &archive,
            false,
            Duration::from_secs(10),
            64
        )
        .is_err());
        assert!(copy_command(
            powershell("Start-Sleep -Seconds 10"),
            &archive,
            false,
            Duration::from_millis(100),
            64
        )
        .is_err());
        archive.set_len(0).unwrap();
        archive.seek(SeekFrom::Start(0)).unwrap();
        archive.write_all(&[0; 65]).unwrap();
        assert!(copy_command(
            powershell("Start-Sleep -Seconds 10"),
            &archive,
            false,
            Duration::from_secs(10),
            64
        )
        .is_err());
        drop(archive);
    }
}
