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
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const SOURCE: &str = "npipe:////./pipe/dockerDesktopLinuxEngine";
const TTL: Duration = Duration::from_secs(120);
const COPY_TIMEOUT: Duration = Duration::from_secs(3600);
static PLAN: Mutex<Option<Plan>> = Mutex::new(None);
static JOB: Mutex<Option<Value>> = Mutex::new(None);
static ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    images: Vec<String>,
    containers: Vec<String>,
    volumes: Vec<String>,
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
    blocked: Vec<String>,
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
    let mut arguments = vec!["--host".into(), host.into()];
    arguments.extend_from_slice(args);
    let output = process::execute(&cli()?, &arguments, None, timeout, 16 * 1024 * 1024)?;
    if !output.status.success() {
        // CLI inspection errors can contain configuration values; do not return raw output.
        return Err(format!("Docker {} 명령이 실패했습니다 (종료 {}). Docker Desktop Linux 엔진과 연결 상태를 확인하세요.", args.first().map(String::as_str).unwrap_or(""), output.status.code().unwrap_or(-1)));
    }
    Ok(output.stdout)
}
fn query(host: &str, args: &[&str]) -> Result<Value, String> {
    serde_json::from_slice(&command(
        host,
        &args.iter().map(|v| (*v).into()).collect::<Vec<_>>(),
        Duration::from_secs(30),
    )?)
    .map_err(|_| "Docker 응답을 읽을 수 없습니다.".into())
}
fn inspect(host: &str, kind: &str, value: &str) -> Result<Value, String> {
    Ok(inspect_many(host, kind, &[value.into()])?.remove(0))
}
fn inspect_many(host: &str, kind: &str, values: &[String]) -> Result<Vec<Value>, String> {
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
    let mut args = vec![kind.into(), "inspect".into()];
    args.extend_from_slice(values);
    let rows: Vec<Value> = serde_json::from_slice(&command(host, &args, Duration::from_secs(30))?)
        .map_err(|_| "Docker 검사 응답이 배열이 아닙니다.")?;
    if rows.len() != values.len() {
        return Err("Docker 검사 대상이 달라졌습니다. 다시 검사하세요.".into());
    }
    Ok(rows)
}
fn lines(kind: &str, extra: &[&str]) -> Result<Vec<Value>, String> {
    let mut args = vec![kind.into(), "ls".into()];
    args.extend(extra.iter().map(|v| (*v).into()));
    args.extend(["--format".into(), "{{json .}}".into()]);
    let output = command(SOURCE, &args, Duration::from_secs(30))?;
    std::str::from_utf8(&output)
        .map_err(|_| "Docker 목록의 인코딩이 올바르지 않습니다.")?
        .lines()
        .filter(|v| !v.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line).map_err(|_| "Docker 목록을 해석할 수 없습니다.".into())
        })
        .collect()
}
fn source_identity() -> Result<String, String> {
    let info = query(SOURCE, &["info", "--format", "{{json .}}"])?;
    if info["OSType"] != "linux"
        || !text(&info, "OperatingSystem")
            .to_ascii_lowercase()
            .contains("docker desktop")
        || text(&info, "ID").is_empty()
    {
        return Err("Docker Desktop Linux 엔진으로 확인된 경우에만 가져올 수 있습니다.".into());
    }
    Ok(text(&info, "ID").into())
}
pub fn inventory() -> Result<Value, String> {
    let target = docker::connected()?;
    let source = source_identity()?;
    if source == target.identity {
        return Err("원본과 대상 엔진이 같습니다.".into());
    }
    let (images, containers, volumes) = thread::scope(|scope| {
        let a = scope.spawn(|| lines("image", &["--no-trunc"]));
        let b = scope.spawn(|| lines("container", &["--all", "--no-trunc"]));
        let c = scope.spawn(|| lines("volume", &[]));
        (a.join(), b.join(), c.join())
    });
    let images = images.map_err(|_| "이미지 목록 조회가 중단되었습니다.")??;
    let containers = containers.map_err(|_| "컨테이너 목록 조회가 중단되었습니다.")??;
    let volumes = volumes.map_err(|_| "볼륨 목록 조회가 중단되었습니다.")??;
    Ok(json!({"sourceEngine":source,"targetEngine":target.identity,
        "images":images.iter().map(|v| json!({"id":v["ID"],"name":format!("{}:{}",text(v,"Repository"),text(v,"Tag")),"detail":v["Size"]})).collect::<Vec<_>>(),
        "containers":containers.iter().map(|v| json!({"id":v["ID"],"name":v["Names"],"detail":v["State"]})).collect::<Vec<_>>(),
        "volumes":volumes.iter().map(|v| json!({"id":v["Name"],"name":v["Name"],"detail":v["Driver"]})).collect::<Vec<_>>() }))
}

fn selection_valid(selection: &Selection) -> bool {
    let count = selection.images.len() + selection.containers.len() + selection.volumes.len();
    (1..=128).contains(&count)
        && selection.images.iter().all(|v| image_id(v))
        && selection.containers.iter().all(|v| id(v))
        && selection.volumes.iter().all(|v| name(v))
}
fn container_blocked(source: &Value) -> Option<&'static str> {
    let host = &source["HostConfig"];
    if !["created", "exited"].contains(&text(&source["State"], "Status")) {
        return Some("원본 컨테이너를 먼저 정상 중지하세요.");
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
    if array(&source["Mounts"])
        .iter()
        .any(|v| v["Type"] != "volume" && v["Type"] != "tmpfs")
    {
        return Some("호스트·Windows·WSL 폴더 연결은 원본 경로를 확인해 직접 옮기세요.");
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
    json!({"Id":container["Id"],"Name":container["Name"],"Image":container["Image"],"Config":container["Config"],"HostConfig":container["HostConfig"],"Mounts":container["Mounts"],"State":container["State"],"Networks":container["NetworkSettings"]["Networks"]})
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
        Duration::from_secs(30),
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
    // Volume users only need state metadata; do not read unselected containers' environments.
    let mut args = vec!["container".into(), "inspect".into(), "--format".into(), r#"{"Id":{{json .Id}},"State":{"Status":{{json .State.Status}},"StartedAt":{{json .State.StartedAt}},"FinishedAt":{{json .State.FinishedAt}}}}"#.into()];
    args.extend(ids);
    let output = command(SOURCE, &args, Duration::from_secs(30))?;
    std::str::from_utf8(&output)
        .map_err(|_| "볼륨 참조 상태를 읽을 수 없습니다.")?
        .lines()
        .map(|v| serde_json::from_str(v).map_err(|_| "볼륨 참조 상태가 올바르지 않습니다.".into()))
        .collect()
}
fn make_plan(selection: Selection, token: String, target: &Client) -> Result<Plan, String> {
    if !selection_valid(&selection) {
        return Err(
            "이미지·컨테이너·볼륨을 1~128개 선택하세요. 올바른 ID와 이름이 필요합니다.".into(),
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
        blocked: vec![],
    };
    let mut image_ids = selection.images;
    let mut volume_names = selection.volumes;
    let mut network_names = Vec::new();
    let target_containers = target.containers()?;
    let containers = inspect_many(SOURCE, "container", &selection.containers)?;
    for (selected, container) in selection.containers.into_iter().zip(containers) {
        if text(&container, "Id") != selected {
            return Err("원본 컨테이너 ID가 변경되었습니다.".into());
        }
        let container_name = text(&container, "Name").trim_start_matches('/');
        if !name(container_name) {
            plan.blocked
                .push("지원하지 않는 원본 컨테이너 이름입니다.".into());
        }
        if let Some(reason) = container_blocked(&container) {
            plan.blocked.push(format!("{container_name}: {reason}"));
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
        if array(&target_volumes["Volumes"])
            .iter()
            .any(|v| v["Name"] == value)
        {
            plan.blocked
                .push(format!("{value}: DockSlate에 같은 볼륨 이름이 있습니다."));
        }
        if volume_references(&value)?
            .iter()
            .any(|v| !["created", "exited"].contains(&text(&v["State"], "Status")))
        {
            plan.blocked.push(format!(
                "{value}: 이 볼륨을 쓰는 모든 컨테이너를 먼저 정상 중지하세요."
            ));
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
        if target_networks.iter().any(|v| v["Name"] == value) {
            plan.blocked.push(format!(
                "{value}: DockSlate에 같은 네트워크 이름이 있습니다."
            ));
        }
        plan.networks.push(network);
    }
    plan.created = Instant::now();
    Ok(plan)
}
fn public_plan(plan: &Plan) -> Value {
    json!({"token":plan.token,"expiresAt":now()+TTL.as_millis() as u64,"eligible":plan.blocked.is_empty(),"blockedReasons":plan.blocked,
        "sourceEngine":plan.source,"targetEngine":plan.target,"images":plan.images.iter().map(|v| text(v,"Id")).collect::<Vec<_>>(),
        "containers":plan.containers.iter().map(|v| text(v,"Name").trim_start_matches('/')).collect::<Vec<_>>(),
        "volumes":plan.volumes.iter().map(|v| text(v,"Name")).collect::<Vec<_>>(),"networks":plan.networks.iter().map(|v| text(v,"Name")).collect::<Vec<_>>()})
}
pub fn preview(selection: Selection) -> Result<Value, String> {
    if is_busy() {
        return Err("데이터 가져오기가 진행 중입니다.".into());
    }
    let plan = make_plan(selection, runtime::new_token()?, &docker::connected()?)?;
    let value = public_plan(&plan);
    *PLAN
        .lock()
        .map_err(|_| "가져오기 승인 정보를 보관할 수 없습니다.")? = if plan.blocked.is_empty() {
        Some(plan)
    } else {
        None
    };
    Ok(value)
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
    Ok(JOB
        .lock()
        .map_err(|_| "가져오기 상태를 읽을 수 없습니다.")?
        .clone()
        .unwrap_or(Value::Null))
}

fn snapshot(plan: &Plan) -> Value {
    json!({"source":plan.source,"target":plan.target,"images":plan.images,"containers":plan.containers.iter().map(fingerprint).collect::<Vec<_>>(),"volumes":plan.volumes,"networks":plan.networks})
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
    let target = docker::connected()?;
    let rechecked = make_plan(plan.selection.clone(), plan.token.clone(), &target)?;
    if !rechecked.blocked.is_empty() || snapshot(&rechecked) != snapshot(&plan) {
        return Err("원본·대상·설정이 검사 후 변경되었습니다. 다시 검사하세요.".into());
    }
    ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "다른 가져오기가 진행 중입니다.")?;
    let initial = json!({"id":plan.token,"state":"running","message":"선택한 데이터를 복사하고 있습니다.","completed":[],"warnings":[]});
    match JOB.lock() {
        Ok(mut job) => *job = Some(initial.clone()),
        Err(_) => {
            ACTIVE.store(false, Ordering::Release);
            return Err("가져오기 상태를 보관할 수 없습니다.".into());
        }
    }
    thread::spawn(move || {
        let result = transfer(&plan, &target);
        if let Ok(mut state) = JOB.lock() {
            if let Some(job) = state.as_mut() {
                job["state"] = json!(if result.is_ok() {
                    "completed"
                } else {
                    "failed"
                });
                job["message"] = json!(if result.is_ok() {
                    "복사가 끝났습니다. 중지된 복사본의 데이터와 설정을 확인한 뒤 직접 시작하세요. Docker Desktop은 아직 제거하지 마세요."
                } else {
                    "복사가 중단되었습니다. 완료 목록의 복사본은 보존했습니다. 원본은 삭제하지 않았습니다."
                });
                if let Err(error) = result {
                    job["error"] = json!(error);
                }
            }
        }
        ACTIVE.store(false, Ordering::Release);
    });
    Ok(initial)
}

struct Workspace {
    root: PathBuf,
    files: Vec<PathBuf>,
}
impl Workspace {
    fn new(token: &str) -> Result<Self, String> {
        let local = PathBuf::from(
            std::env::var_os("LOCALAPPDATA")
                .ok_or("현재 사용자의 앱 데이터 경로를 확인할 수 없습니다.")?,
        );
        if !local.is_absolute() || !local.is_dir() {
            return Err("현재 사용자의 앱 데이터 경로가 올바르지 않습니다.".into());
        }
        let root = local.join("DockSlate/migration").join(token);
        for parent in root
            .ancestors()
            .skip(1)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            if !parent.exists() && parent.starts_with(&local) {
                fs::create_dir(parent).map_err(|_| "앱의 복사 작업 폴더를 만들 수 없습니다.")?;
            }
            let meta =
                fs::symlink_metadata(parent).map_err(|_| "임시 경로를 검사할 수 없습니다.")?;
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("임시 경로의 reparse point는 지원하지 않습니다.".into());
                }
            }
            if meta.file_type().is_symlink() {
                return Err("임시 경로의 심볼릭 링크는 지원하지 않습니다.".into());
            }
        }
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
    // Override image-declared VOLUME paths so helper creation does not allocate anonymous volumes.
    for (path, _) in image["Config"]["Volumes"].as_object().into_iter().flatten() {
        if !path.starts_with('/')
            || path == "/"
            || path.contains(',')
            || path == "/__dockslate_transfer"
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
        Duration::from_secs(30),
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
fn configuration(source: &Value, rootfs_image: &str, token: &str) -> Result<Value, String> {
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
    mounts.extend(array(&source["Mounts"]).iter().filter(|v| v["Type"] == "volume").map(|v| json!({"Type":"volume","Source":v["Name"],"Target":v["Destination"],"ReadOnly":v["RW"]==false,"VolumeOptions":{"NoCopy":true}})));
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
fn transfer(plan: &Plan, target: &Client) -> Result<(), String> {
    let destination = cli_platform::endpoint()?;
    let mut workspace = Workspace::new(&plan.token)?;
    for image in &plan.images {
        same_engines(plan, target)?;
        let image_id = text(image, "Id");
        update(format!("이미지 복사: {image_id}"), None, false);
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
        if inspect(&destination, "image", image_id)?["Id"] != image_id {
            return Err("대상 이미지 ID가 원본과 다릅니다. 결과를 확인하세요.".into());
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
        drop(archive);
        workspace.remove(&path)?;
        update(
            "이미지를 복사했습니다.".into(),
            Some(format!("이미지 {image_id}")),
            false,
        );
    }
    for volume in &plan.volumes {
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
        let result = (|| {
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
            if array(&target.json("GET", "/volumes")?["Volumes"])
                .iter()
                .any(|v| v["Name"] == volume_name)
            {
                return Err(format!("{volume_name}: 대상 볼륨이 이미 있습니다."));
            }
            let body = json!({"Name":volume_name,"Driver":"local","Labels":owned_labels(&volume["Labels"],&plan.token)});
            let created: Value = serde_json::from_slice(&target.transport.create_volume(
                &target.api,
                &serde_json::to_vec(&body).unwrap(),
                Duration::from_secs(30),
                1024 * 1024,
            )?)
            .map_err(|_| "대상 볼륨 생성 결과를 읽지 못했습니다.")?;
            if created["Labels"]["io.dockslate.migration"] != plan.token {
                return Err("대상 볼륨 소유권이 다릅니다. 파일을 쓰지 않았습니다.".into());
            }
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
        let body = json!({"Name":network_name,"Driver":"bridge","CheckDuplicate":true,"Internal":network["Internal"],"Attachable":network["Attachable"],"EnableIPv6":network["EnableIPv6"],"IPAM":network["IPAM"],"Options":network["Options"],"Labels":owned_labels(&network["Labels"],&plan.token)});
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
        let body = configuration(source, rootfs, &plan.token)?;
        let created: Value = serde_json::from_slice(&target.transport.create_container(&target.api,container_name,&serde_json::to_vec(&body).unwrap(),Duration::from_secs(30),1024*1024).map_err(|_| format!("{container_name}: 컨테이너 생성에 실패했습니다. 복사한 이미지·볼륨은 보존했습니다."))?).map_err(|_| "컨테이너 생성 결과를 읽지 못했습니다.")?;
        if !id(text(&created, "Id")) {
            return Err("대상 컨테이너 생성 결과를 확인하지 못했습니다.".into());
        }
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
    Ok(())
}

#[cfg(test)]
mod security_tests {
    use super::*;
    fn source() -> Value {
        json!({"Id":"a".repeat(64),"Name":"/database","Image":format!("sha256:{}","b".repeat(64)),"State":{"Status":"exited","StartedAt":"before"},
            "Config":{"Env":["DB_PASSWORD=fixture-only"],"Cmd":["server"],"Entrypoint":["/entrypoint"],"Labels":{"com.docker.compose.project":"demo"}},
            "HostConfig":{"NetworkMode":"demo_default","PortBindings":{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"15432"}]},"RestartPolicy":{"Name":"unless-stopped"},"Binds":["database:/data"]},
            "Mounts":[{"Type":"volume","Name":"database","Destination":"/data","RW":true}],
            "NetworkSettings":{"Networks":{"demo_default":{"Aliases":["database","a".repeat(12)],"IPAMConfig":null}}}})
    }
    #[test]
    fn migration_selection_rejects_options_paths_and_excessive_work() {
        let mut selection = Selection {
            images: vec![format!("sha256:{}", "b".repeat(64))],
            containers: vec![],
            volumes: vec![],
        };
        assert!(selection_valid(&selection));
        selection.volumes = vec!["-option".into()];
        assert!(!selection_valid(&selection));
        selection.volumes = vec!["../file".into()];
        assert!(!selection_valid(&selection));
        selection.volumes = vec!["safe".into(); 128];
        assert!(!selection_valid(&selection));
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
    fn migration_rejects_live_containers_binds_devices_and_fixed_ips() {
        assert!(container_blocked(&source()).is_none());
        for (path, value) in [
            ("/State/Status", json!("running")),
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
        let source = source();
        let body = configuration(&source, "sha256:new-snapshot", "job").unwrap();
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
        let plan = Plan {
            token: "token".into(),
            created: Instant::now(),
            selection: Selection {
                images: vec![],
                containers: vec![],
                volumes: vec![],
            },
            source: "desktop".into(),
            target: "owned".into(),
            images: vec![],
            containers: vec![container.clone()],
            volumes: vec![],
            networks: vec![],
            blocked: vec![],
        };
        let public = public_plan(&plan).to_string();
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
            },
            source: "desktop".into(),
            target: "owned".into(),
            images: vec![],
            containers: vec![],
            volumes: vec![],
            networks: vec![],
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
