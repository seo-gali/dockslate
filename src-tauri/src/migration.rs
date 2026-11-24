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

mod binds;

const SOURCE: &str = cli_platform::DESKTOP_SOURCE;
const SOURCE_QUERY_TIMEOUT: Duration = Duration::from_secs(120);
const TTL: Duration = Duration::from_secs(120);
const COPY_TIMEOUT: Duration = Duration::from_secs(3600);
static PLAN: Mutex<Option<Plan>> = Mutex::new(None);
static JOB: Mutex<Option<Value>> = Mutex::new(None);
static ACTIVE: AtomicBool = AtomicBool::new(false);

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
    binds: Vec<binds::Copy>,
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
    let output = process::execute(&cli()?, &arguments, None, timeout, 16 * 1024 * 1024)
        .map_err(|error| command_error(host, args, timeout, &error))?;
    if !output.status.success() {
        return Err(command_error(host, args, timeout, &format!("명령이 실패했습니다 (종료 {}). 엔진 연결 상태를 확인하세요.", output.status.code().unwrap_or(-1))));
    }
    Ok(output.stdout)
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
        if host == SOURCE { SOURCE_QUERY_TIMEOUT } else { Duration::from_secs(30) },
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
    let rows: Vec<Value> = serde_json::from_slice(&command(host, &args, if host == SOURCE { SOURCE_QUERY_TIMEOUT } else { Duration::from_secs(30) })?)
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
    let unique = |values: &[String]| {
        let mut ids = values.to_vec();
        ids.sort();
        ids.dedup();
        ids.len() == values.len()
    };
    (1..=128).contains(&count)
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
    let mut args = vec!["container".into(), "inspect".into(), "--format".into(), r#"{"Id":{{json .Id}},"Name":{{json .Name}},"State":{"Status":{{json .State.Status}},"StartedAt":{{json .State.StartedAt}},"FinishedAt":{{json .State.FinishedAt}}},"Mounts":{{json .Mounts}}}"#.into()];
    args.extend(ids);
    let output = command(SOURCE, &args, SOURCE_QUERY_TIMEOUT)?;
    std::str::from_utf8(&output)
        .map_err(|_| "원본 연결 상태의 인코딩이 올바르지 않습니다.")?
        .lines()
        .map(|v| serde_json::from_str(v).map_err(|_| "원본 연결 상태를 읽을 수 없습니다.".into()))
        .collect()
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
    let mut args = vec!["container".into(), "inspect".into(), "--format".into(), r#"{"Id":{{json .Id}},"State":{"Status":{{json .State.Status}},"StartedAt":{{json .State.StartedAt}},"FinishedAt":{{json .State.FinishedAt}}}}"#.into()];
    args.extend(ids);
    let output = command(SOURCE, &args, SOURCE_QUERY_TIMEOUT)?;
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
        reused_networks: vec![],
        binds: vec![],
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
        if array(&target_volumes["Volumes"])
            .iter()
            .any(|v| v["Name"] == binding.volume)
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
        if array(&target_volumes["Volumes"])
            .iter()
            .any(|v| v["Name"] == value)
        {
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
        "dockerSocketContainers":plan.containers.iter().filter(|v| array(&v["Mounts"]).iter().any(binds::socket)).map(|v| text(v,"Name").trim_start_matches('/')).collect::<Vec<_>>(),"reusedNetworks":plan.reused_networks})
}
pub fn preview(selection: Selection) -> Result<Value, String> {
    if is_busy() {
        return Err("데이터 가져오기가 진행 중입니다.".into());
    }
    let mut plan = make_plan(selection, runtime::new_token()?, &docker::connected()?)?;
    let value = public_plan(&mut plan);
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
    json!({"source":plan.source,"target":plan.target,"images":plan.images,"containers":plan.containers.iter().map(fingerprint).collect::<Vec<_>>(),"volumes":plan.volumes,"networks":plan.networks,"binds":plan.binds,"reusedNetworks":plan.reused_networks})
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
    let initial = json!({"id":plan.token,"state":"running","message":"선택한 데이터를 복사하고 있습니다.","completed":[],"warnings":[],"stoppedSources":[],"startedTargets":[]});
    match JOB.lock() {
        Ok(mut job) => *job = Some(initial.clone()),
        Err(_) => {
            ACTIVE.store(false, Ordering::Release);
            return Err("가져오기 상태를 보관할 수 없습니다.".into());
        }
    }
    thread::spawn(move || {
        let result = transfer(rechecked, &target);
        if let Ok(mut state) = JOB.lock() {
            if let Some(job) = state.as_mut() {
                job["state"] = json!(if result.is_ok() {
                    "completed"
                } else {
                    "failed"
                });
                job["message"] = json!(if result.is_ok() {
                    "복사가 끝났습니다. 대상의 데이터와 실행 상태를 확인하세요. Docker Desktop은 확인을 마치기 전까지 제거하지 마세요."
                } else {
                    "이전이 중단되었습니다. 복사본과 원본 데이터는 보존했습니다. 중지한 원본·시작한 복사본 목록을 확인하고 한쪽만 실행하세요."
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
    let mut args = vec!["container".into(), "stop".into(), "--timeout=-1".into()];
    args.extend(running.iter().map(|v| text(v, "Id").to_owned()));
    let result = command(SOURCE, &args, Duration::from_secs(180));
    let after = inspect_many(SOURCE, "container", &ids)?;
    for (previous, current) in before.iter().zip(&after) {
        if !stopped(previous) && stopped(current) {
            record_state(
                "stoppedSources",
                text(current, "Name").trim_start_matches('/'),
            );
        }
        if !same_configuration(previous, current) || !stopped(current) {
            return Err("원본의 정상 종료를 확인하지 못했거나 설정이 변경되었습니다. 강제 종료하지 않았으며 컨테이너·볼륨 데이터 복사는 시작하지 않았습니다. 중지한 원본 목록을 확인하세요.".into());
        }
    }
    result.map_err(|_| "정상 종료 대기 중 오류 또는 3분 제한에 도달했습니다. 강제 종료하지 않았습니다. 원본 상태를 확인하고 다시 검사하세요.".to_owned())?;
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
    let start_names = if plan.selection.start_after_import {
        start_order(&plan.containers)?
    } else {
        vec![]
    };
    stop_sources(plan, target)?;
    for binding in &plan.binds {
        binds::copy(plan, target, binding, &destination, &mut workspace)?;
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
        let output = command(
            &destination,
            &["container".into(), "inspect".into(), container_name.clone()],
            Duration::from_secs(30),
        )?;
        let rows: Vec<Value> =
            serde_json::from_slice(&output).map_err(|_| "복사본 설정을 확인할 수 없습니다.")?;
        let value = rows.first().ok_or("복사본이 없습니다.")?;
        if value["Config"]["Labels"]["io.dockslate.migration"] != plan.token {
            return Err("복사본의 소유권이 변경되었습니다. 시작하지 않았습니다.".into());
        }
        match command(
            &destination,
            &["container".into(), "start".into(), text(value, "Id").into()],
            Duration::from_secs(60),
        ) {
            Ok(_) => {
                record_state("startedTargets", &container_name);
                if inspect(&destination, "container", text(value, "Id"))?["State"]["Running"]
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
