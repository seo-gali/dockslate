use crate::{
    docker::{self, Client},
    resources::{approval_token, encode, now_ms, object_id, EngineBinding, APPROVAL_TTL},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    net::IpAddr,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Port {
    container_port: u16,
    host_port: u16,
    protocol: String,
    host_ip: String,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mount {
    name: String,
    target: String,
    read_only: bool,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    id: String,
    name: String,
    ports: Vec<Port>,
    mounts: Vec<Mount>,
    networks: Vec<String>,
}

struct Approval {
    request: Request,
    source: Value,
    resources: Value,
    engine: EngineBinding,
    recreate: bool,
    created: Instant,
}
static APPROVALS: OnceLock<Mutex<HashMap<String, Approval>>> = OnceLock::new();
fn approvals() -> &'static Mutex<HashMap<String, Approval>> {
    APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn inspect(client: &Client, id: &str) -> Result<Value, String> {
    if !object_id(id) {
        return Err("컨테이너 ID가 올바르지 않습니다.".into());
    }
    let value = client.json("GET", &format!("/containers/{id}/json"))?;
    if text(&value, "Id") != id
        || !value["Config"].is_object()
        || !value["HostConfig"].is_object()
        || !value["Mounts"].is_array()
    {
        return Err("컨테이너 설정과 소유 정보를 확인하지 못했습니다.".into());
    }
    Ok(value)
}
fn settings(source: &Value) -> Result<Request, String> {
    let mut ports = Vec::new();
    for (key, bindings) in source["HostConfig"]["PortBindings"]
        .as_object()
        .into_iter()
        .flatten()
    {
        let (number, protocol) = key
            .split_once('/')
            .ok_or("기존 포트 설정이 올바르지 않습니다.")?;
        for binding in bindings.as_array().into_iter().flatten() {
            ports.push(Port {
                container_port: number.parse().map_err(|_| "기존 포트를 읽지 못했습니다.")?,
                host_port: text(binding, "HostPort").parse().unwrap_or(0),
                protocol: protocol.into(),
                host_ip: if text(binding, "HostIp").is_empty() {
                    "0.0.0.0".into()
                } else {
                    text(binding, "HostIp").into()
                },
            });
        }
    }
    ports.sort_by_key(|port| {
        (
            port.container_port,
            port.protocol.clone(),
            port.host_ip.clone(),
            port.host_port,
        )
    });
    let mut mounts: Vec<_> = source["Mounts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|mount| mount["Type"] == "volume")
        .map(|mount| Mount {
            name: text(mount, "Name").into(),
            target: text(mount, "Destination").into(),
            read_only: mount["RW"] == false,
        })
        .collect();
    mounts.sort_by(|left, right| left.target.cmp(&right.target));
    let mut networks: Vec<_> = source["NetworkSettings"]["Networks"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(_, network)| text(network, "NetworkID").to_owned())
        .collect();
    networks.sort();
    networks.dedup();
    Ok(Request {
        id: text(source, "Id").into(),
        name: text(source, "Name").trim_start_matches('/').into(),
        ports,
        mounts,
        networks,
    })
}
fn fingerprint(source: &Value) -> Value {
    json!({"Id":source["Id"],"Name":source["Name"],"Image":source["Image"],"Config":source["Config"],"HostConfig":source["HostConfig"],"Mounts":source["Mounts"],"state":source["State"]["Status"],"startedAt":source["State"]["StartedAt"],"networks":source["NetworkSettings"]["Networks"]})
}
fn blocked(source: &Value) -> Option<&'static str> {
    let host = &source["HostConfig"];
    if source["Config"]["Labels"]
        .as_object()
        .is_some_and(|labels| {
            labels.keys().any(|key| {
                key.starts_with("com.docker.compose.") || key.starts_with("com.docker.swarm.")
            })
        })
    {
        return Some("Compose·Swarm 컨테이너는 원본 프로젝트에서 연결 설정을 변경하세요. 이름 변경만 지원합니다.");
    }
    if host["AutoRemove"] == true
        || host["Privileged"] == true
        || host["PublishAllPorts"] == true
        || host["VolumesFrom"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
        || host["Links"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
        || ["host", "container"]
            .iter()
            .any(|mode| text(host, "NetworkMode").starts_with(mode))
    {
        return Some(
            "자동 삭제·특권·자동 포트·공유 볼륨·호스트 네트워크 설정은 이름 변경만 지원합니다.",
        );
    }
    if source["NetworkSettings"]["Networks"]
        .as_object()
        .into_iter()
        .flatten()
        .any(|(_, network)| {
            network["IPAMConfig"]
                .as_object()
                .is_some_and(|config| config.values().any(|value| !value.is_null() && value != ""))
        })
    {
        return Some("고정 IP 네트워크 설정은 이름 변경만 지원합니다.");
    }
    None
}
pub fn read(id: String) -> Result<Value, String> {
    let source = inspect(&docker::connected()?, &id)?;
    Ok(
        json!({"settings":settings(&source)?,"state":source["State"]["Status"],"recreateBlockedReason":blocked(&source),"fixedMounts":source["Mounts"].as_array().unwrap().iter().filter(|mount| mount["Type"] != "volume").map(|mount| json!({"kind":mount["Type"],"source":mount["Source"],"target":mount["Destination"],"readOnly":mount["RW"] == false})).collect::<Vec<_>>()}),
    )
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}

fn configuration(
    client: &Client,
    source: &Value,
    request: &Request,
) -> Result<(Value, Value), String> {
    if let Some(reason) = blocked(source) {
        return Err(reason.into());
    }
    if request.ports.len() > 16
        || request.mounts.len() > 16
        || request.networks.is_empty()
        || request.networks.len() > 8
    {
        return Err("포트·볼륨은 각각 16개, 네트워크는 1~8개까지 설정하세요.".into());
    }
    let mut config = source["Config"].clone();
    let mut host = source["HostConfig"].clone();
    let mut bindings = Map::new();
    let mut exposed = source["Config"]["ExposedPorts"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut unique = HashSet::new();
    for port in &request.ports {
        if port.container_port == 0
            || !["tcp", "udp"].contains(&port.protocol.as_str())
            || port.host_ip.parse::<IpAddr>().is_err()
            || !unique.insert((
                port.container_port,
                port.protocol.clone(),
                port.host_ip.clone(),
                port.host_port,
            ))
        {
            return Err(
                "포트·프로토콜·호스트 IP를 확인하세요. 같은 연결을 중복 지정할 수 없습니다.".into(),
            );
        }
        let key = format!("{}/{}", port.container_port, port.protocol);
        exposed.insert(key.clone(), json!({}));
        bindings
            .entry(key)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap()
            .push(json!({"HostIp":port.host_ip,"HostPort":port.host_port.to_string()}));
    }
    host["PortBindings"] = json!(bindings);
    config["ExposedPorts"] = json!(exposed);
    let old_volumes: HashSet<_> = source["Mounts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|mount| mount["Type"] == "volume")
        .map(|mount| text(mount, "Name"))
        .collect();
    host["Binds"] = json!(host["Binds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|bind| !old_volumes
            .contains(bind.as_str().unwrap_or("").split(':').next().unwrap_or("")))
        .cloned()
        .collect::<Vec<_>>());
    let mut mounts: Vec<_> = host["Mounts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|mount| mount["Type"] != "volume")
        .cloned()
        .collect();
    let mut targets: HashSet<String> = source["Mounts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|mount| mount["Type"] != "volume")
        .map(|mount| text(mount, "Destination").to_owned())
        .collect();
    let mut volumes = Vec::new();
    for mount in &request.mounts {
        if !valid_name(&mount.name)
            || mount.target.len() > 4096
            || !mount.target.starts_with('/')
            || mount.target == "/"
            || mount.target.contains('\0')
            || mount
                .target
                .split('/')
                .any(|part| matches!(part, "." | ".."))
            || !targets.insert(mount.target.trim_end_matches('/').into())
        {
            return Err("볼륨 이름과 중복되지 않는 내부 절대 경로를 확인하세요. 루트·상위 경로는 사용할 수 없습니다.".into());
        }
        let volume = client.json("GET", &format!("/volumes/{}", encode(&mount.name)))?;
        if volume["Name"] != mount.name
            || volume["Driver"] != "local"
            || volume["Scope"] != "local"
            || volume["Options"]
                .as_object()
                .is_some_and(|options| !options.is_empty())
        {
            return Err(
                "기존 local 볼륨만 선택할 수 있습니다. 볼륨은 리소스 화면에서 먼저 만드세요."
                    .into(),
            );
        }
        volumes.push(volume);
        mounts.push(json!({"Type":"volume","Source":mount.name,"Target":mount.target,"ReadOnly":mount.read_only,"VolumeOptions":{"NoCopy":true}}));
    }
    if source["Config"]["Volumes"]
        .as_object()
        .into_iter()
        .flatten()
        .any(|(target, _)| !targets.contains(target.trim_end_matches('/')))
    {
        return Err("이미지가 선언한 기본 볼륨 경로는 연결을 유지해야 합니다. 연결할 볼륨 이름을 바꿀 수 있습니다.".into());
    }
    host["Mounts"] = json!(mounts);
    let mut networks = Vec::new();
    let mut endpoints = Map::new();
    let mut seen = HashSet::new();
    for id in &request.networks {
        if !object_id(id) || !seen.insert(id) {
            return Err("네트워크 ID가 올바르지 않거나 중복되었습니다.".into());
        }
        let mut network = client.json("GET", &format!("/networks/{id}"))?;
        if network["Id"] != *id
            || network["Scope"] != "local"
            || network["Ingress"] == true
            || network["ConfigOnly"] == true
            || !["bridge", "null"].contains(&text(&network, "Driver"))
        {
            return Err("로컬 bridge 또는 none 네트워크만 지원합니다.".into());
        }
        if network["Driver"] == "null" && (request.networks.len() != 1 || !request.ports.is_empty())
        {
            return Err(
                "none 네트워크는 다른 네트워크·공개 포트와 함께 사용할 수 없습니다.".into(),
            );
        }
        let name = text(&network, "Name").to_owned();
        let mut endpoint = json!({});
        if let Some(previous) = source["NetworkSettings"]["Networks"].get(&name) {
            for key in ["Aliases", "DriverOpts", "GwPriority"] {
                if !previous[key].is_null() {
                    endpoint[key] = previous[key].clone();
                }
            }
        }
        endpoints.insert(name.clone(), endpoint);
        if networks.is_empty() {
            host["NetworkMode"] = json!(if name == "none" { "none" } else { &name });
        }
        network.as_object_mut().unwrap().remove("Containers");
        networks.push(network);
    }
    config["NetworkDisabled"] = json!(networks[0]["Name"] == "none");
    config["HostConfig"] = host;
    config["NetworkingConfig"] = json!({"EndpointsConfig":endpoints});
    if config["Labels"].is_null() {
        config["Labels"] = json!({});
    }
    config["Labels"]["dev.dockslate.edit.origin"] = json!(request.id);
    if serde_json::to_vec(&config)
        .map_err(|_| "설정을 구성하지 못했습니다.")?
        .len()
        > 64 * 1024
    {
        return Err("컨테이너 설정은 64KB까지 지원합니다.".into());
    }
    Ok((config, json!({"networks":networks,"volumes":volumes})))
}
pub fn preview(mut request: Request) -> Result<Value, String> {
    if !valid_name(&request.name) {
        return Err("컨테이너 이름은 영문·숫자로 시작하는 1~128자의 영문·숫자·밑줄·마침표·하이픈으로 입력하세요.".into());
    }
    request.ports.sort_by_key(|port| {
        (
            port.container_port,
            port.protocol.clone(),
            port.host_ip.clone(),
            port.host_port,
        )
    });
    request
        .mounts
        .sort_by(|left, right| left.target.cmp(&right.target));
    request.networks.sort();
    let client = docker::connected()?;
    let source = inspect(&client, &request.id)?;
    let current = settings(&source)?;
    if current == request {
        return Err("변경한 설정이 없습니다.".into());
    }
    if !matches!(
        source["State"]["Status"].as_str(),
        Some("running" | "created" | "exited")
    ) {
        return Err("실행 중·생성됨·중지됨 상태에서만 수정할 수 있습니다.".into());
    }
    if client.containers()?.iter().any(|container| {
        text(container, "Id") != request.id
            && container["Names"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|name| name.as_str().unwrap_or("").trim_start_matches('/') == request.name)
    }) {
        return Err("같은 이름의 컨테이너가 있습니다.".into());
    }
    let recreate = current.ports != request.ports
        || current.mounts != request.mounts
        || current.networks != request.networks;
    let resources = if recreate {
        configuration(&client, &source, &request)?.1
    } else {
        Value::Null
    };
    let token = approval_token()?;
    let result = json!({"token":token,"expiresAt":now_ms()+APPROVAL_TTL.as_millis() as u64,"before":current,"after":request,"recreate":recreate,"wasRunning":source["State"]["Running"],"networkNames":resources["networks"].as_array().into_iter().flatten().map(|network|network["Name"].clone()).collect::<Vec<_>>()});
    let mut approvals = approvals()
        .lock()
        .map_err(|_| "승인 상태를 확인하지 못했습니다.")?;
    approvals.retain(|_, approval| approval.created.elapsed() < APPROVAL_TTL);
    if approvals.len() >= 16 {
        return Err("열린 승인 요청이 너무 많습니다. 잠시 후 다시 시도하세요.".into());
    }
    approvals.insert(
        token,
        Approval {
            request,
            source: fingerprint(&source),
            resources,
            engine: EngineBinding::capture(&client),
            recreate,
            created: Instant::now(),
        },
    );
    Ok(result)
}
fn rename(client: &Client, id: &str, name: &str) -> Result<(), String> {
    client
        .json(
            "POST",
            &format!("/containers/{id}/rename?name={}", encode(name)),
        )
        .map(|_| ())
}
fn stopped(client: &Client, id: &str) -> Result<(), String> {
    if inspect(client, id)?["State"]["Running"] == true {
        client.json("POST", &format!("/containers/{id}/stop?t=10"))?;
    }
    if inspect(client, id)?["State"]["Running"] != false {
        return Err("컨테이너 중지를 확인하지 못했습니다.".into());
    }
    Ok(())
}
pub fn execute(token: String, approved: bool) -> Result<Value, String> {
    if !approved {
        return Err("설정 변경에는 명시적인 승인이 필요합니다.".into());
    }
    let approval = approvals()
        .lock()
        .map_err(|_| "승인 상태를 확인하지 못했습니다.")?
        .remove(&token)
        .ok_or("승인 정보가 없거나 이미 사용되었습니다.")?;
    if approval.created.elapsed() >= APPROVAL_TTL {
        return Err("승인 정보가 만료되었습니다. 다시 검사하세요.".into());
    }
    let client = docker::connected()?;
    approval.engine.verify(&client)?;
    let request = &approval.request;
    let source = inspect(&client, &request.id)?;
    if fingerprint(&source) != approval.source {
        return Err("컨테이너 상태나 설정이 변경되었습니다. 다시 검사하세요.".into());
    }
    if !approval.recreate {
        rename(&client, &request.id, &request.name)?;
        return Ok(
            json!({"id":request.id,"name":request.name,"recreated":false,"message":"컨테이너 이름을 변경했습니다."}),
        );
    }
    let (mut config, resources) = configuration(&client, &source, request)?;
    if resources != approval.resources {
        return Err("선택한 볼륨·네트워크가 변경되었습니다. 다시 검사하세요.".into());
    }
    let was_running = source["State"]["Running"] == true;
    let old_name = text(&source, "Name").trim_start_matches('/');
    let temporary = format!("dockslate-edit-{}", &approval_token()?[..20]);
    let retained = format!(
        "{}.dockslate-old-{}",
        &old_name[..old_name.len().min(80)],
        &request.id[..12]
    );
    let mut created_id: Option<String> = None;
    let mut saved_image: Option<String> = None;
    let result = (|| -> Result<Value, String> {
        stopped(&client, &request.id)?;
        let committed = client.bytes(
            "POST",
            &format!(
                "/commit?container={}&repo=dockslate-edits/{}&tag={}&pause=false",
                request.id,
                &request.id[..12],
                &temporary[15..]
            ),
            Duration::from_secs(180),
            1024 * 1024,
        )?;
        let image: Value = serde_json::from_slice(&committed)
            .map_err(|_| "파일 보존 이미지 응답을 읽지 못했습니다.")?;
        let image_id = text(&image, "Id");
        if !image_id.strip_prefix("sha256:").is_some_and(object_id) {
            return Err("파일 보존 이미지 ID를 확인하지 못했습니다.".into());
        }
        saved_image = Some(image_id.into());
        config["Image"] = json!(image_id);
        let body = serde_json::to_vec(&config).map_err(|_| "설정을 구성하지 못했습니다.")?;
        let bytes = client.transport.create_container(
            &client.api,
            &temporary,
            &body,
            Duration::from_secs(30),
            1024 * 1024,
        )?;
        let created: Value =
            serde_json::from_slice(&bytes).map_err(|_| "새 컨테이너 응답을 읽지 못했습니다.")?;
        let id = text(&created, "Id");
        if !object_id(id) {
            return Err("새 컨테이너 ID를 확인하지 못했습니다.".into());
        }
        created_id = Some(id.into());
        rename(&client, &request.id, &retained)?;
        rename(&client, id, &request.name)?;
        if was_running {
            client.json("POST", &format!("/containers/{id}/start"))?;
        }
        let actual = inspect(&client, id)?;
        if text(&actual, "Name").trim_start_matches('/') != request.name
            || (was_running && actual["State"]["Running"] != true)
            || actual["Image"] != image_id
        {
            return Err("새 컨테이너의 이름·실행 상태·보존 이미지를 확인하지 못했습니다.".into());
        }
        let settings = settings(&actual)?;
        if settings.mounts != request.mounts
            || settings.networks != request.networks
            || settings.ports != request.ports
        {
            return Err("새 컨테이너의 포트·볼륨·네트워크가 승인한 설정과 다릅니다.".into());
        }
        let cleanup = client.json(
            "DELETE",
            &format!("/containers/{}?force=false&v=false", request.id),
        );
        Ok(
            json!({"id":id,"name":request.name,"recreated":true,"savedImage":saved_image,"retainedContainer":if cleanup.is_err(){Some(&request.id)}else{None},"message":if cleanup.is_err(){"새 컨테이너로 전환했습니다. 기존 컨테이너 삭제에 실패하여 중지 상태로 남겨 두었습니다. 기존 볼륨은 유지됩니다."}else{"설정을 변경했습니다. 컨테이너 ID가 변경되었으며 기존 파일과 볼륨은 유지됩니다."}}),
        )
    })();
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let mut failures = Vec::new();
            if let Some(id) = &created_id {
                let cleanup = stopped(&client, id).and_then(|_| {
                    client
                        .json("DELETE", &format!("/containers/{id}?force=false&v=false"))
                        .map(|_| ())
                });
                if let Err(failure) = cleanup {
                    failures.push(format!("새 컨테이너 {id} 정리 실패: {failure}"));
                }
            }
            let restore = (|| -> Result<(), String> {
                let current = inspect(&client, &request.id)?;
                if text(&current, "Name").trim_start_matches('/') != old_name {
                    rename(&client, &request.id, old_name)?;
                }
                if was_running && current["State"]["Running"] != true {
                    client.json("POST", &format!("/containers/{}/start", request.id))?;
                }
                Ok(())
            })();
            if let Err(failure) = restore {
                failures.push(format!("기존 컨테이너 {} 복구 실패: {failure}", request.id));
            }
            Err(format!("설정 변경 실패: {error}\n{}\n보존 이미지: {}. 볼륨은 삭제하지 않았습니다. 알 수 없는 생성 결과는 {temporary} 이름으로 확인하세요.",if failures.is_empty(){"기존 컨테이너의 이름과 실행 상태를 복구했습니다.".into()}else{failures.join("\n")},saved_image.unwrap_or_else(||"없음".into())))
        }
    }
}
