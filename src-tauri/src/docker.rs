use crate::runtime::Transport;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const ENDPOINT: &str = "wsl://DockSlate/var/run/docker.sock";
const BODY_LIMIT: usize = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
static MUTATION: Mutex<()> = Mutex::new(());
static PREVIEWS: OnceLock<Mutex<HashMap<String, Preview>>> = OnceLock::new();
static LOG_FORMATS: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
static PULLING: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
pub(crate) struct Client {
    pub(crate) transport: Transport,
    context: String,
    owner: String,
    pub(crate) api: String,
    server: String,
    pub(crate) identity: String,
    cache_api_supported: bool,
    engine_cpu_count: Option<u64>,
    memory_total_bytes: Option<u64>,
}
#[derive(Clone)]
struct Preview {
    kind: String,
    ids: Vec<String>,
    image_ids: Vec<String>,
    cache_ids: Vec<String>,
    expires: u64,
    identity: String,
    context: String,
    owner: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn status(state: &str, message: &str, context: Option<&str>, owner: Option<&str>) -> Value {
    json!({"state":state,"context":context,"endpoint":ENDPOINT,"engine":null,"serverVersion":null,"apiVersion":null,"ownerPath":owner,"message":message})
}
fn failure_state(message: &str) -> &'static str {
    if message.starts_with("A runtime or disk operation is running;") {
        "busy"
    } else if message.contains("error 5")
        || message.to_ascii_lowercase().contains("permission denied")
    {
        "permission_denied"
    } else if message.starts_with("Unsupported")
        || message.contains("verification")
        || message.contains("cannot be verified")
    {
        "unsupported"
    } else {
        "unavailable"
    }
}
fn api_number(value: &str) -> Result<u32, String> {
    let Some(minor) = value.strip_prefix("1.") else {
        return Err("Unsupported Docker API version".into());
    };
    minor
        .parse()
        .map_err(|_| "Unsupported Docker API version".into())
}

fn probe() -> Result<(Value, Option<Client>), String> {
    probe_transport(Transport::discover())
}

fn probe_transport(
    transport: Result<Transport, String>,
) -> Result<(Value, Option<Client>), String> {
    let transport = match transport {
        Ok(transport) => transport,
        Err(message) => {
            return Ok((
                status(failure_state(&message), &message, Some("DockSlate"), None),
                None,
            ))
        }
    };
    let owner = transport.owner.clone();
    let context = transport.context.clone();
    let result: Result<(Value, Option<Client>), String> = (|| {
        let version: Value = serde_json::from_slice(&transport.request(
            "GET",
            "/version",
            REQUEST_TIMEOUT,
            BODY_LIMIT,
        )?)
        .map_err(|_| "Invalid Docker version response")?;
        if version["Os"].as_str() != Some("linux")
            || !version["Components"].as_array().is_some_and(|parts| {
                parts
                    .iter()
                    .any(|part| part["Name"].as_str() == Some("Engine"))
            })
        {
            return Err(
                "Unsupported engine; Linux Moby Engine required, containerd is not Docker Engine"
                    .into(),
            );
        }
        let server = version["Version"]
            .as_str()
            .ok_or("Docker Engine version unavailable")?
            .to_owned();
        let max_api = api_number(
            version["ApiVersion"]
                .as_str()
                .ok_or("Docker API version unavailable")?,
        )?;
        let min_api = api_number(
            version["MinAPIVersion"]
                .as_str()
                .ok_or("Docker minimum API version unavailable")?,
        )?;
        let negotiated = max_api.min(55);
        if negotiated < min_api || negotiated < 41 {
            return Err("Unsupported Docker API range; API 1.41 through 1.55 required".into());
        }
        let api = format!("1.{negotiated}");
        let mut client = Client {
            transport,
            context: context.clone(),
            owner: owner.clone(),
            api: api.clone(),
            server: server.clone(),
            identity: String::new(),
            cache_api_supported: min_api <= 51 && max_api >= 51,
            engine_cpu_count: None,
            memory_total_bytes: None,
        };
        let info = client.json("GET", "/info")?;
        if info["OSType"].as_str() != Some("linux")
            || info["OperatingSystem"]
                .as_str()
                .is_some_and(|os| os.to_ascii_lowercase().contains("docker desktop"))
        {
            return Err("Unsupported engine operating system".into());
        }
        client.identity = info["ID"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("Engine identity unavailable; operation blocked")?
            .to_owned();
        client.engine_cpu_count = info["NCPU"].as_u64().filter(|count| *count > 0);
        client.memory_total_bytes = info["MemTotal"].as_u64().filter(|bytes| *bytes > 0);
        Ok((
            json!({"state":"connected","context":context,"endpoint":ENDPOINT,"engine":"moby","provider":"DockSlate","serverVersion":server,"apiVersion":api,"ownerPath":owner,"message":"Verified independent DockSlate Moby Engine"}),
            Some(client),
        ))
    })();
    match result {
        Ok(value) => Ok(value),
        Err(message) => Ok((
            status(
                failure_state(&message),
                &message,
                Some(&context),
                Some(&owner),
            ),
            None,
        )),
    }
}

impl Client {
    pub(crate) fn bytes(
        &self,
        method: &str,
        path: &str,
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        self.bytes_version(&self.api, method, path, timeout, limit)
    }
    fn bytes_version(
        &self,
        api: &str,
        method: &str,
        path: &str,
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        self.transport.request(method, &format!("/v{api}{path}"), timeout, limit).map_err(|message| {
            if method != "GET" && !message.starts_with("Docker HTTP") && !message.starts_with("Invalid internal Docker request") { format!("{message}. The operation outcome is unknown; refresh the engine state before retrying.") } else { message }
        })
    }
    pub(crate) fn json(&self, method: &str, path: &str) -> Result<Value, String> {
        let body = self.bytes(method, path, REQUEST_TIMEOUT, BODY_LIMIT)?;
        if body.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&body).map_err(|_| "Invalid Docker JSON response".into())
    }
    pub(crate) fn containers(&self) -> Result<Vec<Value>, String> {
        self.json("GET", "/containers/json?all=1")?
            .as_array()
            .cloned()
            .ok_or_else(|| "Invalid Docker container list".into())
    }
    fn images(&self) -> Result<Vec<Value>, String> {
        self.json("GET", "/images/json?all=0")?
            .as_array()
            .cloned()
            .ok_or_else(|| "Invalid Docker image list".into())
    }
    pub(crate) fn usage(&self) -> Result<Value, String> {
        let usage = self.json("GET", "/system/df")?;
        for key in ["Images", "Containers", "Volumes", "BuildCache"] {
            if !usage
                .get(key)
                .is_some_and(|value| value.is_array() || value.is_null())
            {
                return Err(format!("Docker disk usage field {key} is unavailable"));
            }
        }
        Ok(usage)
    }
    fn cache_supported(&self) -> bool {
        self.cache_api_supported
    }
    fn prune_cache(&self, filters: &str) -> Result<Value, String> {
        if !self.cache_supported() {
            return Err("Selective cache cleanup requires supported Docker API 1.51".into());
        }
        let body = self.bytes_version(
            "1.51",
            "POST",
            &format!("/build/prune?all=0&filters={filters}"),
            REQUEST_TIMEOUT,
            BODY_LIMIT,
        )?;
        serde_json::from_slice(&body)
            .map_err(|_| "Invalid Docker cache cleanup response; outcome may be unknown".into())
    }
}
pub(crate) fn connected() -> Result<Client, String> {
    let (state, client) = probe()?;
    client.ok_or_else(|| text(&state, "message").to_owned())
}

pub(crate) struct BuildEngine(Client);
pub(crate) fn prepare_image_build() -> Result<BuildEngine, String> {
    connected().map(BuildEngine)
}
impl BuildEngine {
    pub(crate) fn path(&self, path: &str) -> Result<String, String> {
        self.0.transport.build_path(path)
    }
    fn verify_identity(&self) -> Result<(), String> {
        if text(&self.0.json("GET", "/info")?, "ID") != self.0.identity {
            return Err("엔진 ID가 변경되었습니다. 연결을 새로고침한 뒤 다시 빌드하세요.".into());
        }
        Ok(())
    }
    pub(crate) fn spawn_on(
        &self,
        context: &str,
        dockerfile: &str,
        tag: &str,
        no_cache: bool,
        builder: &str,
    ) -> Result<std::process::Child, String> {
        self.verify_identity()?;
        self.0
            .transport
            .spawn_configured_image_build(context, dockerfile, tag, no_cache, builder)
    }
    pub(crate) fn image_id(&self, tag: &str) -> Result<String, String> {
        self.verify_identity()?;
        let image = self
            .0
            .json("GET", &format!("/images/{}/json", encode(tag)))?;
        let id = text(&image, "Id");
        if !image_id(id) {
            return Err("빌드한 로컬 이미지 ID를 확인할 수 없습니다.".into());
        }
        Ok(id.into())
    }
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn array(value: &Value, key: &str) -> Vec<Value> {
    value[key].as_array().cloned().unwrap_or_default()
}
fn image_id(id: &str) -> bool {
    id.strip_prefix("sha256:").is_some_and(container_id)
}
fn container_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn cache_id(id: &str) -> bool {
    (1..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric())
}
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

pub fn engine_status() -> Result<Value, String> {
    probe().map(|(status, _)| status)
}
fn unavailable_snapshot(engine: Result<Value, String>, message: String) -> Value {
    let error: Result<Value, String> = Err(message);
    json!({"engine_status":engine,"overview":error,"containers_list":error,"images_list":error,"disk_usage":error,"volumes_list":error,"networks_list":error})
}
pub fn dashboard_snapshot() -> Result<Value, String> {
    std::thread::scope(|scope| {
        let inventory = scope.spawn(crate::wsl::inventory);
        let runtime = crate::runtime::inspect_status();
        let transport = runtime
            .as_ref()
            .map_err(Clone::clone)
            .and_then(Transport::from_status);
        let mut snapshot = docker_snapshot(transport);
        if let Some(object) = snapshot.as_object_mut() {
            object.insert(
                "runtime_status".into(),
                json!(runtime.map(crate::runtime::public_status)),
            );
            object.insert(
                "wsl_inventory".into(),
                json!(inventory
                    .join()
                    .unwrap_or_else(|_| Err("WSL disk inventory worker failed.".into()))),
            );
        }
        Ok(snapshot)
    })
}

fn docker_snapshot(transport: Result<Transport, String>) -> Value {
    let (engine, client) = match probe_transport(transport) {
        Ok(result) => result,
        Err(message) => {
            return unavailable_snapshot(Err(message.clone()), message);
        }
    };
    let Some(client) = client else {
        let message = text(&engine, "message").to_owned();
        return unavailable_snapshot(Ok(engine), message);
    };
    let (containers, images, usage, networks) = std::thread::scope(|scope| {
        let containers = scope.spawn(|| client.containers());
        let images = scope.spawn(|| client.images());
        let usage = scope.spawn(|| client.usage());
        let networks = scope.spawn(|| client.json("GET", "/networks"));
        (
            containers
                .join()
                .unwrap_or_else(|_| Err("Container snapshot worker failed.".into())),
            images
                .join()
                .unwrap_or_else(|_| Err("Image snapshot worker failed.".into())),
            usage
                .join()
                .unwrap_or_else(|_| Err("Docker usage snapshot worker failed.".into())),
            networks
                .join()
                .unwrap_or_else(|_| Err("Network snapshot worker failed.".into())),
        )
    });
    let volumes = match (&usage, &containers) {
        (Ok(usage), Ok(containers)) => crate::volumes::list_from_snapshot(usage, containers),
        (Err(message), _) | (_, Err(message)) => Err(message.clone()),
    };
    let networks = match (&networks, &containers) {
        (Ok(networks), Ok(containers)) => {
            crate::resources::networks_from_values(networks, containers)
        }
        (Err(error), _) | (_, Err(error)) => Err(error.clone()),
    };
    let container_list = containers
        .as_ref()
        .map(|items| normalize_containers(items))
        .map_err(Clone::clone);
    let image_list = match (&images, &containers) {
        (Ok(images), Ok(containers)) => Ok(normalize_images(images, containers)),
        (Err(message), _) | (_, Err(message)) => Err(message.clone()),
    };
    let disk_usage = match (&usage, &containers) {
        (Ok(usage), Ok(containers)) => Ok(summarize_usage(&client, usage, containers)),
        (Err(message), _) | (_, Err(message)) => Err(message.clone()),
    };
    let overview = match (&usage, &containers, &images) {
        (Ok(usage), Ok(containers), Ok(images)) => Ok(summarize_overview(
            &engine, &client, containers, images, usage,
        )),
        (Err(message), _, _) | (_, Err(message), _) | (_, _, Err(message)) => Err(message.clone()),
    };
    let engine_status: Result<Value, String> = Ok(engine);
    json!({"engine_status":engine_status,"overview":overview,"containers_list":container_list,"images_list":image_list,"disk_usage":disk_usage,"volumes_list":volumes,"networks_list":networks})
}
pub fn overview() -> Result<Value, String> {
    let (engine, client) = probe()?;
    let Some(client) = client else {
        return Ok(
            json!({"engine":engine,"containersRunning":null,"containersStopped":null,"images":null,"dockerBytes":null,"reclaimableBytes":null}),
        );
    };
    let containers = client.containers()?;
    let images = client.images()?;
    let usage_data = client.usage()?;
    Ok(summarize_overview(
        &engine,
        &client,
        &containers,
        &images,
        &usage_data,
    ))
}
fn summarize_overview(
    engine: &Value,
    client: &Client,
    containers: &[Value],
    images: &[Value],
    usage_data: &Value,
) -> Value {
    let usage = summarize_usage(client, usage_data, containers);
    let running = containers
        .iter()
        .filter(|c| ["running", "restarting", "paused"].contains(&text(c, "State")))
        .count();
    let cache_values = array(usage_data, "BuildCache");
    let unshared_cache = if cache_values
        .iter()
        .any(|cache| cache["Shared"].as_bool().is_none())
    {
        None
    } else {
        measured_sum(
            &cache_values
                .into_iter()
                .filter(|cache| cache["Shared"].as_bool() == Some(false))
                .collect::<Vec<_>>(),
            "Size",
        )
    };
    let total = [
        usage["imagesBytes"].as_u64(),
        usage["containersBytes"].as_u64(),
        usage["volumesBytes"].as_u64(),
        unshared_cache,
    ]
    .into_iter()
    .try_fold(0u64, |sum, value| {
        value.map(|value| sum.saturating_add(value))
    });
    json!({"engine":engine,"containersRunning":running,"containersStopped":containers.len()-running,"images":images.len(),"dockerBytes":total,"reclaimableBytes":usage["reclaimableBytes"]})
}
pub fn containers_list() -> Result<Value, String> {
    let client = connected()?;
    Ok(normalize_containers(&client.containers()?))
}
fn normalize_containers(containers: &[Value]) -> Value {
    let items: Vec<_> = containers.iter().map(|c| {
        let ports = array(c, "Ports").iter().map(|p| {
            let Some(private) = p["PrivatePort"].as_u64() else { return "Port unavailable".to_owned(); };
            let kind = text(p, "Type");
            if let Some(public) = p["PublicPort"].as_u64() { format!("{}:{public} → {private}/{kind}", p["IP"].as_str().unwrap_or("IP unavailable")) } else { format!("{private}/{kind}") }
        }).collect::<Vec<_>>().join(", ");
        let name = c["Names"].as_array().and_then(|names| names.first()).and_then(Value::as_str).unwrap_or("").trim_start_matches('/');
        json!({"id":c["Id"],"name":name,"image":c["Image"],"state":c["State"],"status":c["Status"],"ports":ports,"publishedPorts":array(c,"Ports").iter().filter(|p|p["PublicPort"].as_u64().is_some()).map(|p|json!({"privatePort":p["PrivatePort"],"publicPort":p["PublicPort"],"protocol":p["Type"],"ip":p["IP"]})).collect::<Vec<_>>(),"composeProject":c["Labels"]["com.docker.compose.project"].as_str()})
    }).collect();
    json!(items)
}
pub fn container_action(id: String, action: String) -> Result<Value, String> {
    let _lock = MUTATION.lock().map_err(|_| "Operation lock unavailable")?;
    if !container_id(&id)
        || !["start", "stop", "restart", "pause", "unpause"].contains(&action.as_str())
    {
        return Err("Unsupported container action or ID".into());
    }
    let client = connected()?;
    let container = client
        .containers()?
        .into_iter()
        .find(|c| text(c, "Id") == id)
        .ok_or("Container no longer exists")?;
    if action == "start" && ["running", "paused", "restarting"].contains(&text(&container, "State"))
    {
        return Err("Container is already active".into());
    }
    if action == "stop" && !["running", "paused", "restarting"].contains(&text(&container, "State"))
    {
        return Err("Container is already stopped".into());
    }
    if action == "pause" && text(&container, "State") != "running" {
        return Err("실행 중인 컨테이너만 일시정지할 수 있습니다.".into());
    }
    if action == "unpause" && text(&container, "State") != "paused" {
        return Err("일시정지된 컨테이너만 다시 실행할 수 있습니다.".into());
    }
    let query = if ["stop", "restart"].contains(&action.as_str()) {
        "?t=10".into()
    } else {
        String::new()
    };
    client.json("POST", &format!("/containers/{id}/{action}{query}"))?;
    let inspected = client.json("GET", &format!("/containers/{id}/json"))?;
    let state = text(&inspected["State"], "Status");
    let exit_code = inspected["State"]["ExitCode"].as_i64();
    let message = if action == "start" && matches!(state, "exited" | "dead") {
        format!(
            "컨테이너가 종료되었습니다. 종료 코드: {}",
            exit_code.unwrap_or(-1)
        )
    } else {
        format!(
            "{} 완료",
            match action.as_str() {
                "start" => "시작",
                "stop" => "중지",
                "restart" => "재시작",
                "pause" => "일시정지",
                _ => "다시 진행",
            }
        )
    };
    Ok(
        json!({"message":message,"state":state,"exitCode":exit_code,"startedAt":inspected["State"]["StartedAt"],"finishedAt":inspected["State"]["FinishedAt"]}),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContainerPort {
    container_port: u16,
    host_port: Option<u16>,
    protocol: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RestartPolicy {
    No,
    OnFailure,
    Always,
    UnlessStopped,
}
impl RestartPolicy {
    fn name(&self) -> &'static str {
        match self {
            Self::No => "no",
            Self::OnFailure => "on-failure",
            Self::Always => "always",
            Self::UnlessStopped => "unless-stopped",
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ContainerOptions {
    env: Vec<String>,
    command: Vec<String>,
    entrypoint: Vec<String>,
    working_dir: String,
    restart_policy: Option<RestartPolicy>,
    network_id: Option<String>,
    memory_bytes: Option<u64>,
    nano_cpus: Option<u64>,
    mounts: Vec<VolumeMount>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VolumeMount {
    name: String,
    target: String,
    #[serde(default)]
    read_only: bool,
}
impl ContainerOptions {
    fn validate(&self) -> Result<(), String> {
        fn bounded(values: &[String], each: usize, total: usize) -> bool {
            values.len() <= 64
                && values
                    .iter()
                    .all(|value| value.len() <= each && !value.contains('\0'))
                && values.iter().map(String::len).sum::<usize>() <= total
        }
        if !bounded(&self.env, 8192, 32 * 1024) {
            return Err("환경 변수는 최대 64개, 각 8192바이트, 합계 32KB까지 입력할 수 있습니다. NUL 문자는 사용할 수 없습니다.".into());
        }
        let mut keys = HashSet::new();
        for entry in &self.env {
            let (key, _) = entry
                .split_once('=')
                .ok_or("환경 변수는 KEY=value 형식으로 입력하세요.")?;
            if key.is_empty()
                || !(key.as_bytes()[0].is_ascii_alphabetic() || key.starts_with('_'))
                || !key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                || !keys.insert(key)
            {
                return Err("환경 변수 이름은 영문 또는 밑줄로 시작하며 영문·숫자·밑줄만 사용할 수 있습니다. 같은 이름은 한 번만 입력하세요.".into());
            }
        }
        if !bounded(&self.command, 4096, 16 * 1024) || !bounded(&self.entrypoint, 4096, 16 * 1024) {
            return Err("명령 인수와 Entrypoint는 각각 최대 64개, 인수당 4096바이트, 합계 16KB까지 입력할 수 있습니다. NUL 문자는 사용할 수 없습니다.".into());
        }
        if !self.working_dir.is_empty()
            && (self.working_dir.len() > 4096
                || !self.working_dir.starts_with('/')
                || self.working_dir.contains('\0'))
        {
            return Err("작업 폴더는 /로 시작하는 컨테이너 내부 절대 경로를 입력하세요. 최대 4096바이트입니다.".into());
        }
        if self
            .network_id
            .as_ref()
            .is_some_and(|id| !id.is_empty() && !container_id(id))
        {
            return Err("선택한 Docker 네트워크 ID가 올바르지 않습니다.".into());
        }
        if self
            .memory_bytes
            .is_some_and(|bytes| !(16_000_000..=1_000_000_000_000).contains(&bytes))
        {
            return Err("메모리 제한은 16MB부터 1TB까지 입력하세요.".into());
        }
        if self
            .nano_cpus
            .is_some_and(|cpus| !(100_000_000..=128_000_000_000).contains(&cpus))
        {
            return Err("CPU 제한은 0.1개부터 128개까지 입력하세요.".into());
        }
        let mut targets = HashSet::new();
        if self.mounts.len() > 8 {
            return Err("볼륨은 최대 8개까지 연결할 수 있습니다.".into());
        }
        for mount in &self.mounts {
            if mount.name.is_empty()
                || mount.name.len() > 255
                || !mount.name.as_bytes()[0].is_ascii_alphanumeric()
                || !mount
                    .name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
            {
                return Err("선택한 볼륨 이름이 올바르지 않습니다.".into());
            }
            if !mount.target.starts_with('/')
                || mount.target == "/"
                || mount.target.len() > 4096
                || mount.target.contains('\0')
                || mount
                    .target
                    .split('/')
                    .any(|part| part == ".." || part == ".")
                || !targets.insert(mount.target.trim_end_matches('/'))
            {
                return Err("볼륨 대상은 중복되지 않는 컨테이너 내부 절대 경로를 지정하세요. 루트 경로와 상위 경로는 사용할 수 없습니다.".into());
            }
        }
        Ok(())
    }
}

fn supported_network(network: &Value) -> bool {
    container_id(text(network, "Id"))
        && network["Scope"].as_str() == Some("local")
        && network["ConfigOnly"].as_bool() == Some(false)
        && network["Ingress"].as_bool() != Some(true)
        && network["Internal"].as_bool().is_some()
        && (text(network, "Driver") == "bridge"
            || (text(network, "Driver") == "null" && text(network, "Name") == "none"))
}

pub fn network_create(name: String, internal: bool) -> Result<Value, String> {
    let _lock = MUTATION.lock().map_err(|_| "Operation lock unavailable")?;
    let name = name.trim();
    if name.is_empty()
        || name.len() > 63
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
        || ["bridge", "host", "none", "default", "ingress"].contains(&name)
    {
        return Err("네트워크 이름은 영문·숫자로 시작하는 1~63자의 영문·숫자·밑줄·마침표·하이픈을 사용하세요. 기본 네트워크 이름은 사용할 수 없습니다.".into());
    }
    let client = connected()?;
    let networks = client.json("GET", "/networks")?;
    let networks = networks
        .as_array()
        .ok_or("Docker 네트워크 목록을 확인하지 못했습니다.")?;
    if networks.iter().any(|network| text(network, "Name") == name) {
        return Err("같은 이름의 Docker 네트워크가 이미 있습니다. 다른 이름을 입력하세요.".into());
    }
    let body = serde_json::to_vec(&json!({
        "Name":name,"Driver":"bridge","Scope":"local","Internal":internal,
        "Attachable":false,"Ingress":false,"ConfigOnly":false
    }))
    .map_err(|_| "네트워크 생성 요청을 구성하지 못했습니다.")?;
    let response =
        client
            .transport
            .create_network(&client.api, &body, REQUEST_TIMEOUT, BODY_LIMIT)?;
    let response: Value = serde_json::from_slice(&response)
        .map_err(|_| "네트워크 생성 응답을 읽지 못했습니다. 네트워크 목록을 새로고침하세요.")?;
    let id = text(&response, "Id");
    if !container_id(id) {
        return Err(
            "생성된 네트워크 ID를 확인하지 못했습니다. 네트워크 목록을 새로고침하세요.".into(),
        );
    }
    let network = client
        .json("GET", &format!("/networks/{id}"))
        .map_err(|error| format!("네트워크 {name} ({id})를 생성했지만 설정 확인을 완료하지 못했습니다. 네트워크 목록을 새로고침하세요. {error}"))?;
    if !supported_network(&network)
        || text(&network, "Id") != id
        || text(&network, "Name") != name
        || text(&network, "Driver") != "bridge"
        || network["Internal"] != internal
    {
        return Err(format!(
            "네트워크 {name} ({id})의 설정이 요청과 다릅니다. 네트워크 목록을 새로고침하세요."
        ));
    }
    Ok(json!({"id":id,"name":name,"internal":internal}))
}

fn local_image(client: &Client, id: &str) -> Result<Value, String> {
    if !image_id(id) {
        return Err("로컬 이미지 ID가 올바르지 않습니다.".into());
    }
    let image = client.json("GET", &format!("/images/{}/json", encode(id)))?;
    if text(&image, "Id") != id || image["Os"].as_str() != Some("linux") {
        return Err("선택한 로컬 Linux 이미지의 ID를 확인하지 못했습니다.".into());
    }
    Ok(image)
}

pub fn image_details(id: String) -> Result<Value, String> {
    if !image_id(&id) {
        return Err("로컬 이미지 ID가 올바르지 않습니다.".into());
    }
    let client = connected()?;
    let image = local_image(&client, &id)?;
    let config = &image["Config"];
    let mut ports: Vec<_> = config["ExposedPorts"]
        .as_object()
        .into_iter()
        .flat_map(|ports| ports.keys())
        .filter(|key| {
            key.split_once('/').is_some_and(|(port, protocol)| {
                port.parse::<u16>().is_ok_and(|port| port > 0) && ["tcp", "udp"].contains(&protocol)
            })
        })
        .cloned()
        .collect();
    ports.sort();
    let strings = |value: &Value| -> Vec<String> {
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    };
    Ok(json!({
        "id":id,
        "tags":strings(&image["RepoTags"]),
        "exposedPorts":ports,
        "entrypoint":strings(&config["Entrypoint"]),
        "command":strings(&config["Cmd"])
    }))
}

pub fn container_run(
    image_id_value: String,
    name: String,
    ports: Vec<ContainerPort>,
    options: Option<ContainerOptions>,
) -> Result<Value, String> {
    let _lock = MUTATION.lock().map_err(|_| "Operation lock unavailable")?;
    if !image_id(&image_id_value) {
        return Err("로컬 이미지 ID가 올바르지 않습니다.".into());
    }
    let name = name.trim();
    if !name.is_empty()
        && (name.len() > 128
            || !name.as_bytes()[0].is_ascii_alphanumeric()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte)))
    {
        return Err("컨테이너 이름은 영문·숫자로 시작하며 영문·숫자·밑줄·마침표·하이픈을 사용할 수 있습니다. 최대 128자입니다.".into());
    }
    if ports.len() > 8 {
        return Err("포트 연결은 최대 8개까지 추가할 수 있습니다.".into());
    }
    let options = options.unwrap_or_default();
    options.validate()?;
    let mut seen = HashSet::new();
    let mut host_ports = HashSet::new();
    let mut exposed = serde_json::Map::new();
    let mut bindings = serde_json::Map::new();
    for port in ports {
        if port.container_port == 0
            || port.host_port == Some(0)
            || !["tcp", "udp"].contains(&port.protocol.as_str())
        {
            return Err("포트는 1~65535, 프로토콜은 TCP 또는 UDP를 사용하세요.".into());
        }
        let key = format!("{}/{}", port.container_port, port.protocol);
        if !seen.insert(key.clone())
            || port
                .host_port
                .is_some_and(|host| !host_ports.insert((host, port.protocol.clone())))
        {
            return Err("같은 컨테이너 포트 또는 호스트 포트를 중복 연결할 수 없습니다.".into());
        }
        exposed.insert(key.clone(), json!({}));
        bindings.insert(
            key,
            json!([{"HostIp":"127.0.0.1","HostPort":port.host_port.map(|host| host.to_string()).unwrap_or_default()}]),
        );
    }
    let client = connected()?;
    let _ = local_image(&client, &image_id_value)?;
    let mut mounts = Vec::new();
    for mount in &options.mounts {
        let volume = client.json("GET", &format!("/volumes/{}", encode(&mount.name)))?;
        if text(&volume, "Name") != mount.name
            || volume["Driver"].as_str() != Some("local")
            || volume["Scope"].as_str() != Some("local")
            || volume["Options"]
                .as_object()
                .is_some_and(|options| !options.is_empty())
        {
            return Err("기본 local 드라이버의 기존 볼륨만 연결할 수 있습니다. Volumes에서 볼륨을 먼저 만드세요.".into());
        }
        mounts.push(json!({"Type":"volume","Source":mount.name,"Target":mount.target,"ReadOnly":mount.read_only,"VolumeOptions":{"NoCopy":true}}));
    }
    let mut config = json!({
        "Image":image_id_value,
        "ExposedPorts":exposed,
        "HostConfig":{
            "PortBindings":bindings,
            "AutoRemove":false,
            "Privileged":false,
            "PublishAllPorts":false
        }
    });
    if !options.env.is_empty() {
        config["Env"] = json!(options.env);
    }
    if !mounts.is_empty() {
        config["HostConfig"]["Mounts"] = json!(mounts);
    }
    if !options.command.is_empty() {
        config["Cmd"] = json!(options.command);
    }
    if !options.entrypoint.is_empty() {
        config["Entrypoint"] = json!(options.entrypoint);
    }
    if !options.working_dir.is_empty() {
        config["WorkingDir"] = json!(options.working_dir);
    }
    if let Some(policy) = options.restart_policy {
        config["HostConfig"]["RestartPolicy"] = json!({"Name":policy.name(),"MaximumRetryCount":0});
    }
    if let Some(memory) = options.memory_bytes {
        config["HostConfig"]["Memory"] = json!(memory);
    }
    if let Some(cpus) = options.nano_cpus {
        config["HostConfig"]["NanoCpus"] = json!(cpus);
    }
    if let Some(network_id) = options.network_id.filter(|id| !id.is_empty()) {
        let network = client.json("GET", &format!("/networks/{network_id}"))?;
        if text(&network, "Id") != network_id || !supported_network(&network) {
            return Err("선택한 네트워크가 변경되었거나 지원되지 않습니다. 로컬 bridge 또는 기본 none 네트워크만 사용할 수 있습니다.".into());
        }
        let mode = if text(&network, "Driver") == "null" {
            if !bindings.is_empty() {
                return Err("none 네트워크에서는 포트를 연결할 수 없습니다. 포트 연결을 지우거나 다른 네트워크를 선택하세요.".into());
            }
            "none"
        } else {
            &network_id
        };
        config["HostConfig"]["NetworkMode"] = json!(mode);
    }
    let body =
        serde_json::to_vec(&config).map_err(|_| "컨테이너 생성 요청을 구성하지 못했습니다.")?;
    if body.len() > 64 * 1024 {
        return Err("컨테이너 설정은 합계 64KB까지 입력할 수 있습니다.".into());
    }
    let created =
        client
            .transport
            .create_container(&client.api, name, &body, REQUEST_TIMEOUT, BODY_LIMIT)?;
    let created: Value = serde_json::from_slice(&created).map_err(|_| {
        "컨테이너 생성 응답을 읽지 못했습니다. Containers에서 생성 여부를 확인하세요."
    })?;
    let id = text(&created, "Id");
    if !container_id(id) {
        return Err(
            "생성된 컨테이너 ID를 확인하지 못했습니다. Containers에서 생성 여부를 확인하세요."
                .into(),
        );
    }
    let warnings: Vec<_> = array(&created, "Warnings")
        .into_iter()
        .filter_map(|warning| warning.as_str().map(str::to_owned))
        .collect();
    if let Err(error) = client.json("POST", &format!("/containers/{id}/start")) {
        let inspected = client
            .json("GET", &format!("/containers/{id}/json"))
            .ok()
            .filter(|container| text(container, "Id") == id);
        let state = inspected
            .as_ref()
            .and_then(|container| container["State"]["Status"].as_str())
            .unwrap_or("unknown");
        let actual_name = inspected
            .as_ref()
            .map(|container| text(container, "Name").trim_start_matches('/'))
            .filter(|name| !name.is_empty())
            .unwrap_or(name);
        return Ok(json!({
            "id":id,"name":actual_name,"state":state,"started":false,"warnings":warnings,
            "message":format!("컨테이너를 생성했지만 시작 요청을 완료하지 못했습니다. Containers에서 상태와 로그를 확인하세요. {error}")
        }));
    }
    match client.json("GET", &format!("/containers/{id}/json")) {
        Ok(container) if text(&container, "Id") == id => {
            let state = container["State"]["Status"].as_str().unwrap_or("unknown");
            let message = match state {
                "running" => "컨테이너를 시작했습니다.",
                "exited" => "컨테이너를 시작했으며 이미지의 실행 명령이 종료되었습니다. Containers에서 종료 코드와 로그를 확인하세요.",
                _ => "시작 요청을 완료했습니다. Containers에서 현재 상태와 로그를 확인하세요.",
            };
            Ok(
                json!({"id":id,"name":text(&container,"Name").trim_start_matches('/'),"state":state,"started":true,"message":message,"warnings":warnings}),
            )
        }
        _ => Ok(json!({
            "id":id,"name":name,"state":"unknown","started":true,"warnings":warnings,
            "message":"시작 요청을 완료했지만 현재 상태를 확인하지 못했습니다. Containers에서 확인하세요."
        })),
    }
}

pub fn container_inspect(id: String) -> Result<Value, String> {
    if !container_id(&id) {
        return Err("컨테이너 ID가 올바르지 않습니다.".into());
    }
    inspect_container(&connected()?, &id)
}

fn inspect_container(client: &Client, id: &str) -> Result<Value, String> {
    let bytes = client.bytes(
        "GET",
        &format!("/containers/{id}/json?size=false"),
        REQUEST_TIMEOUT,
        2 * 1024 * 1024,
    )?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "컨테이너 Inspect 응답을 읽지 못했습니다.")?;
    if text(&value, "Id") != id {
        return Err("컨테이너 Inspect 응답의 ID가 요청과 다릅니다.".into());
    }
    Ok(value)
}

fn unavailable_stats(id: &str, reason: &str) -> Value {
    json!({
        "id":id,"cpuPercent":null,"memoryUsageBytes":null,"memoryLimitBytes":null,
        "memoryPercent":null,"readAt":null,"cpuReason":reason,"memoryReason":reason,
        "cpuUsageDelta":null,"systemUsageDelta":null,"onlineCpus":null,
        "memoryRawUsageBytes":null,"memoryCacheBytes":null
    })
}

fn stats_with_client(client: &Client, id: &str, state: Option<&str>) -> Value {
    if !matches!(state, Some("running" | "paused")) {
        let reason = if state.is_some() {
            "실행 중이거나 일시정지된 컨테이너의 사용량만 조회합니다."
        } else {
            "컨테이너가 더 이상 존재하지 않습니다."
        };
        return unavailable_stats(id, reason);
    }
    let result: Result<Value, String> = (|| {
        let bytes = client.bytes(
            "GET",
            &format!("/containers/{id}/stats?stream=false"),
            Duration::from_secs(5),
            1024 * 1024,
        )?;
        let stats: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "컨테이너 사용량 응답을 읽지 못했습니다.")?;
        if stats["id"].as_str() != Some(id) {
            return Err("컨테이너 사용량 응답의 ID가 요청과 다릅니다.".into());
        }
        Ok(normalize_stats(id, &stats))
    })();
    result.unwrap_or_else(|reason| unavailable_stats(id, &reason))
}

fn normalize_stats(id: &str, stats: &Value) -> Value {
    let timestamp = |field: &str| {
        stats[field]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 128 && !value.starts_with("0001-"))
    };
    let read_at = timestamp("read");
    let previous_at = timestamp("preread");
    let current = &stats["cpu_stats"];
    let previous = &stats["precpu_stats"];
    let cpu_delta = current["cpu_usage"]["total_usage"]
        .as_u64()
        .zip(previous["cpu_usage"]["total_usage"].as_u64())
        .and_then(|(current, previous)| current.checked_sub(previous));
    let system_delta = current["system_cpu_usage"]
        .as_u64()
        .zip(previous["system_cpu_usage"].as_u64())
        .and_then(|(current, previous)| {
            (previous > 0)
                .then(|| current.checked_sub(previous))
                .flatten()
        })
        .filter(|delta| *delta > 0);
    let cpus = current["online_cpus"]
        .as_u64()
        .filter(|count| *count > 0)
        .or_else(|| {
            current["cpu_usage"]["percpu_usage"]
                .as_array()
                .map(|values| values.len() as u64)
                .filter(|count| *count > 0)
        });
    let cpu_percent = cpu_delta
        .zip(system_delta)
        .zip(cpus)
        .filter(|_| read_at.is_some() && previous_at.is_some() && read_at != previous_at)
        .map(|((cpu, system), cpus)| cpu as f64 / system as f64 * cpus as f64 * 100.0)
        .filter(|percent| percent.is_finite());
    let memory = &stats["memory_stats"];
    let raw_usage = memory["usage"].as_u64();
    let cache = memory["stats"]["total_inactive_file"]
        .as_u64()
        .or_else(|| memory["stats"]["inactive_file"].as_u64());
    let usage = raw_usage
        .zip(cache)
        .and_then(|(usage, cache)| usage.checked_sub(cache));
    let limit = memory["limit"].as_u64().filter(|bytes| *bytes > 0);
    let memory_percent = usage
        .zip(limit)
        .map(|(usage, limit)| usage as f64 / limit as f64 * 100.0)
        .filter(|percent| percent.is_finite());
    let cpu_reason = cpu_percent
        .is_none()
        .then_some("CPU 사용량 계산에 필요한 두 시점의 샘플 또는 CPU 수를 확인하지 못했습니다.");
    let memory_reason = if usage.is_none() {
        Some("메모리 사용량 또는 Linux 캐시 값을 확인하지 못했습니다.")
    } else if limit.is_none() {
        Some("메모리 제한을 확인하지 못했습니다.")
    } else {
        None
    };
    json!({
        "id":id,"cpuPercent":cpu_percent,"memoryUsageBytes":usage,"memoryLimitBytes":limit,
        "memoryPercent":memory_percent,"readAt":read_at,"cpuReason":cpu_reason,"memoryReason":memory_reason,
        "cpuUsageDelta":cpu_delta,"systemUsageDelta":system_delta,"onlineCpus":cpus,
        "memoryRawUsageBytes":raw_usage,"memoryCacheBytes":cache
    })
}

pub fn container_stats(id: String) -> Result<Value, String> {
    if !container_id(&id) {
        return Err("컨테이너 ID가 올바르지 않습니다.".into());
    }
    let client = connected()?;
    let containers = client.containers()?;
    let state = containers
        .iter()
        .find(|container| text(container, "Id") == id)
        .map(|container| text(container, "State"));
    Ok(stats_with_client(&client, &id, state))
}

pub fn containers_metrics(ids: Vec<String>) -> Result<Value, String> {
    let mut unique = HashSet::new();
    if ids.len() > 256 || ids.iter().any(|id| !container_id(id) || !unique.insert(id)) {
        return Err(
            "사용량을 조회할 컨테이너 ID는 중복 없이 최대 256개까지 지정할 수 있습니다.".into(),
        );
    }
    let client = connected()?;
    let containers = client.containers();
    let samples = match containers {
        Err(reason) => ids
            .iter()
            .map(|id| unavailable_stats(id, &reason))
            .collect::<Vec<_>>(),
        Ok(containers) => {
            let states: HashMap<_, _> = containers
                .iter()
                .map(|container| (text(container, "Id"), text(container, "State")))
                .collect();
            let next = std::sync::atomic::AtomicUsize::new(0);
            let batches = std::thread::scope(|scope| {
                let mut workers = Vec::new();
                for _ in 0..ids.len().min(4) {
                    workers.push(scope.spawn(|| {
                        let mut values = Vec::new();
                        loop {
                            let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            let Some(id) = ids.get(index) else { break };
                            values.push((
                                index,
                                stats_with_client(&client, id, states.get(id.as_str()).copied()),
                            ));
                        }
                        values
                    }));
                }
                workers
                    .into_iter()
                    .flat_map(|worker| worker.join().unwrap_or_default())
                    .collect::<Vec<_>>()
            });
            let mut samples: Vec<_> = ids
                .iter()
                .map(|id| unavailable_stats(id, "사용량 조회 작업을 완료하지 못했습니다."))
                .collect();
            for (index, sample) in batches {
                samples[index] = sample;
            }
            samples
        }
    };
    Ok(json!({
        "samples":samples,"engineCpuCount":client.engine_cpu_count,
        "memoryTotalBytes":client.memory_total_bytes,"measuredAt":now_ms()
    }))
}

fn browser_endpoint(private_port: u16, public_port: u16) -> Result<String, String> {
    if matches!(
        private_port,
        1433 | 1521 | 3306 | 5432 | 5672 | 6379 | 6380 | 9042 | 11211 | 27017..=27019
    ) {
        return Err("This port is normally used by a database or messaging client. Copy the address and connect with the corresponding client instead of a browser.".into());
    }
    let program = crate::runtime::system_directory()?.join("curl.exe");
    if !program.is_file() {
        return Err(
            "Windows curl is unavailable; the port's HTTP protocol cannot be verified.".into(),
        );
    }
    let schemes = if matches!(private_port, 443 | 8443 | 9443) {
        ["https", "http"]
    } else {
        ["http", "https"]
    };
    for scheme in schemes {
        let url = format!("{scheme}://127.0.0.1:{public_port}/");
        let args: Vec<String> = [
            "--disable",
            "--silent",
            "--show-error",
            "--noproxy",
            "*",
            "--proto",
            "=http,https",
            "--http1.1",
            "--head",
            "--insecure",
            "--connect-timeout",
            "0.5",
            "--max-time",
            "1.2",
            "--max-filesize",
            "16384",
            "--output",
            "NUL",
            "--write-out",
            "%{http_code}",
            "--",
            &url,
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let output = crate::process::execute(
            &program,
            &args,
            None,
            Duration::from_millis(1500),
            16 * 1024,
        );
        if let Ok(output) = output {
            let code = std::str::from_utf8(&output.stdout)
                .ok()
                .and_then(|text| text.trim().parse::<u16>().ok());
            if output.status.success() && code.is_some_and(|code| (100..600).contains(&code)) {
                return Ok(url);
            }
        }
    }
    Err("No HTTP or HTTPS response was detected on this published port. The service may still be starting or may require a different client.".into())
}

pub fn container_open_port(
    id: String,
    private_port: u16,
    public_port: u16,
) -> Result<Value, String> {
    if !container_id(&id) || private_port == 0 || public_port == 0 {
        return Err("컨테이너 ID와 포트를 확인하세요.".into());
    }
    let container = inspect_container(&connected()?, &id)?;
    if container["State"]["Running"].as_bool() != Some(true) {
        return Err("실행 중인 컨테이너의 포트만 열 수 있습니다.".into());
    }
    let bindings = &container["NetworkSettings"]["Ports"][format!("{private_port}/tcp")];
    let verified = bindings.as_array().is_some_and(|bindings| {
        bindings.iter().any(|binding| {
            binding["HostPort"]
                .as_str()
                .and_then(|port| port.parse::<u16>().ok())
                == Some(public_port)
                && matches!(binding["HostIp"].as_str(), Some("127.0.0.1" | "0.0.0.0"))
        })
    });
    if !verified {
        return Err(
            "선택한 포트의 로컬 TCP 연결을 확인하지 못했습니다. 전체 새로고침 후 다시 시도하세요."
                .into(),
        );
    }
    let url = browser_endpoint(private_port, public_port)?;
    #[cfg(windows)]
    {
        use std::{ffi::c_void, os::windows::ffi::OsStrExt};
        #[link(name = "shell32")]
        unsafe extern "system" {
            fn ShellExecuteW(
                window: *mut c_void,
                operation: *const u16,
                file: *const u16,
                parameters: *const u16,
                directory: *const u16,
                show: i32,
            ) -> *mut c_void;
        }
        let file: Vec<_> = std::ffi::OsStr::new(&url)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let operation: Vec<_> = "open".encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if result as isize <= 32 {
            return Err(
                "기본 브라우저를 열지 못했습니다. Windows의 기본 앱 설정을 확인하세요.".into(),
            );
        }
        Ok(json!({"url":url}))
    }
    #[cfg(not(windows))]
    {
        Err("컨테이너 포트 열기는 Windows에서 지원합니다.".into())
    }
}

pub fn container_logs(id: String) -> Result<Value, String> {
    if !container_id(&id) {
        return Err("Invalid container ID".into());
    }
    let client = connected()?;
    let key = format!("{}:{id}", client.identity);
    let tty = LOG_FORMATS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Log format cache unavailable")?
        .get(&key)
        .copied();
    let tty = match tty {
        Some(value) => value,
        None => {
            let inspect = client.json("GET", &format!("/containers/{id}/json"))?;
            let value = inspect["Config"]["Tty"]
                .as_bool()
                .ok_or("Container log format unavailable")?;
            let mut formats = LOG_FORMATS
                .get()
                .unwrap()
                .lock()
                .map_err(|_| "Log format cache unavailable")?;
            if formats.len() >= 64 {
                formats.clear();
            }
            formats.insert(key, value);
            value
        }
    };
    let body = client.bytes(
        "GET",
        &format!("/containers/{id}/logs?stdout=1&stderr=1&timestamps=1&tail=300&follow=0"),
        REQUEST_TIMEOUT,
        4 * 1024 * 1024,
    )?;
    let mut content = Vec::new();
    if tty {
        content = body;
    } else {
        let mut position = 0;
        while position < body.len() {
            if body.len() - position < 8
                || ![0, 1, 2].contains(&body[position])
                || body[position + 1..position + 4] != [0, 0, 0]
            {
                return Err("Invalid Docker log stream framing".into());
            }
            let size = u32::from_be_bytes(
                body[position + 4..position + 8]
                    .try_into()
                    .map_err(|_| "Invalid Docker log frame")?,
            ) as usize;
            position += 8;
            if body.len() - position < size {
                return Err("Incomplete Docker log frame".into());
            }
            content.extend_from_slice(&body[position..position + size]);
            position += size;
        }
    }
    let truncated = content.len() > 1024 * 1024;
    if truncated {
        content.drain(..content.len() - 1024 * 1024);
    }
    Ok(
        json!({"content":String::from_utf8_lossy(&content),"truncated":truncated,"tail":300,"follow":false}),
    )
}
pub fn images_list() -> Result<Value, String> {
    let client = connected()?;
    let containers = client.containers()?;
    Ok(normalize_images(&client.images()?, &containers))
}
fn normalize_images(images: &[Value], containers: &[Value]) -> Value {
    let mut references = HashMap::<&str, usize>::new();
    for container in containers {
        *references.entry(text(container, "ImageID")).or_default() += 1;
    }
    let values: Vec<_> = images.iter().map(|image| {
        let id = text(image, "Id");
        let count = references.get(id).copied().unwrap_or(0);
        let tags: Vec<_> = array(image, "RepoTags").into_iter().filter(|tag| tag.as_str() != Some("<none>:<none>")).collect();
        json!({"id":id,"tags":tags,"size":image["Size"],"containers":count,"created":image["Created"]})
    }).collect();
    json!(values)
}
pub fn image_search(term: String) -> Result<Value, String> {
    let term = term.trim();
    if term.is_empty()
        || term.len() > 128
        || !term
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_.-".contains(&b))
        || term.contains("..")
        || term.split('/').any(|part| {
            part.is_empty()
                || !part.as_bytes()[0].is_ascii_alphanumeric()
                || !part.as_bytes()[part.len() - 1].is_ascii_alphanumeric()
        })
        || term
            .split_once('/')
            .is_some_and(|(namespace, _)| namespace.contains('.'))
    {
        return Err("Docker Hub 검색어는 1~128자의 영문, 숫자, /, _, ., -로 입력하세요. 외부 레지스트리 주소는 검색할 수 없습니다.".into());
    }
    let client = connected()?;
    let body = client.bytes(
        "GET",
        &format!("/images/search?term={}&limit=25", encode(term)),
        REQUEST_TIMEOUT,
        512 * 1024,
    )?;
    let response: Value = serde_json::from_slice(&body)
        .map_err(|_| "Docker Hub returned an invalid search response")?;
    let rows = response
        .as_array()
        .ok_or("Docker Hub returned an invalid search result list")?;
    let mut results = Vec::new();
    for row in rows.iter().take(25) {
        let name = row["name"]
            .as_str()
            .filter(|name| {
                !name.is_empty()
                    && name.len() <= 256
                    && name.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b"/_.-".contains(&b)
                    })
                    && !name.contains("..")
                    && name.split('/').count() <= 2
                    && name.split('/').all(|part| {
                        !part.is_empty()
                            && part.as_bytes()[0].is_ascii_alphanumeric()
                            && part.as_bytes()[part.len() - 1].is_ascii_alphanumeric()
                    })
            })
            .ok_or("Docker Hub returned an invalid repository name")?;
        results.push(json!({
            "name": name,
            "description": text(row, "description").chars().take(1000).collect::<String>(),
            "starCount": row["star_count"].as_u64().unwrap_or(0),
            "isOfficial": row["is_official"].as_bool().unwrap_or(false)
        }));
    }
    Ok(json!(results))
}
pub fn image_pull(reference: String) -> Result<Value, String> {
    image_pull_with_progress(reference, |_| {})
}

pub fn is_pulling() -> bool {
    PULLING.load(Ordering::Acquire)
}

pub fn image_pull_with_progress(
    reference: String,
    emit: impl FnMut(Value) + Send + 'static,
) -> Result<Value, String> {
    let _lock = MUTATION.lock().map_err(|_| "Operation lock unavailable")?;
    if reference.is_empty()
        || reference.len() > 256
        || reference.starts_with(['-', '/', ':', '.', '@'])
        || !reference
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_.-:@".contains(&b))
        || reference.contains("..")
    {
        return Err("Invalid image reference".into());
    }
    let reference =
        if !reference.contains('@') && !reference.rsplit('/').next().unwrap_or("").contains(':') {
            format!("{reference}:latest")
        } else {
            reference
        };
    struct PullGuard;
    impl Drop for PullGuard {
        fn drop(&mut self) {
            PULLING.store(false, Ordering::Release);
        }
    }
    PULLING.store(true, Ordering::Release);
    let _pull_guard = PullGuard;
    let progress = crate::image_pull::Progress::new(reference.clone(), emit);
    let outcome: Result<Value, String> = (|| {
        let client = connected()?;
        let body = client.transport.request_observed(
            "POST",
            &format!(
                "/v{}/images/create?fromImage={}",
                client.api,
                encode(&reference)
            ),
            Duration::from_secs(15 * 60),
            32 * 1024 * 1024,
            progress.observer(),
        )?;
        let mut final_status = None;
        for line in body.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            let value: Value = serde_json::from_slice(line)
                .map_err(|_| "Invalid Docker pull progress response; outcome may be unknown")?;
            if let Some(error) = value["error"].as_str() {
                return Err(format!(
                    "Image pull failed: {}",
                    error.chars().take(1000).collect::<String>()
                ));
            }
            if let Some(status) = value["status"].as_str() {
                final_status = Some(status.chars().take(300).collect::<String>());
            }
        }
        let final_status = final_status.ok_or("Image pull returned no completion response")?;
        progress.phase("verifying", "Verifying the downloaded image", None);
        let image = client.json("GET", &format!("/images/{}/json", encode(&reference)))?;
        if !image_id(text(&image, "Id")) {
            return Err(format!("Pull response completed ({final_status}), but the requested image identity could not be verified"));
        }
        Ok(json!({"message":format!("Image pull completed: {final_status}")}))
    })();
    match &outcome {
        Ok(_) => progress.phase("completed", "Image pull completed", None),
        Err(error) => progress.phase("failed", "Image pull failed", Some(error)),
    }
    outcome
}

fn measured_sum(values: &[Value], key: &str) -> Option<u64> {
    values.iter().try_fold(0u64, |sum, value| {
        value[key].as_u64().map(|number| sum.saturating_add(number))
    })
}
fn aggregate_size(usage: &Value, key: &str, fallback: Option<u64>) -> Option<u64> {
    let Some(aggregate) = usage.get(key).and_then(Value::as_object) else {
        return fallback;
    };
    match aggregate.get("TotalSize") {
        Some(value) => value.as_u64(),
        None => Some(0),
    }
}
fn summarize_usage(client: &Client, usage: &Value, containers: &[Value]) -> Value {
    let referenced_images: HashSet<_> = containers
        .iter()
        .map(|container| text(container, "ImageID"))
        .collect();
    let image_values = array(usage, "Images");
    let container_values = array(usage, "Containers");
    let volume_values = array(usage, "Volumes");
    let caches = array(usage, "BuildCache");
    let mut reclaimable = Some(0u64);
    let images: Vec<_> = image_values.iter().map(|image| {
        let id = text(image,"Id");
        let referenced = referenced_images.contains(id);
        let eligible = image_id(id) && !referenced;
        let unique = image["Size"].as_u64().zip(image["SharedSize"].as_u64()).map(|(size,shared)|size.saturating_sub(shared));
        if eligible { reclaimable = reclaimable.zip(unique).map(|(sum,unique)|sum.saturating_add(unique)); }
        let label = array(image,"RepoTags").iter().filter_map(Value::as_str).filter(|tag| *tag != "<none>:<none>").collect::<Vec<_>>().join(", ");
        json!({"id":id,"label":if label.is_empty(){id.to_owned()}else{label},"size":image["Size"],"createdAt":image["Created"],"eligible":eligible,"reason":if referenced {Some("Referenced by an existing container")} else if !image_id(id) {Some("Invalid image identity")} else {None},"estimatedReclaimableBytes":unique})
    }).collect();
    let build_cache: Vec<_> = caches.iter().map(|cache| {
        let id = text(cache,"ID");
        let in_use = cache["InUse"].as_bool() != Some(false);
        let shared = cache["Shared"].as_bool() != Some(false);
        let record_type = text(cache,"Type");
        let reason = if !client.cache_supported() { Some("Selective build cache cleanup requires supported Docker API 1.51") }
            else if in_use { Some("Build cache is in use or its usage is unknown") }
            else if shared { Some("Build cache is shared with an image or its sharing state is unknown") }
            else if ["internal", "frontend"].contains(&record_type) { Some("Internal/frontend cache is excluded") }
            else if !cache_id(id) { Some("Invalid build cache identity") } else { None };
        if cache["InUse"].as_bool().is_none() || cache["Shared"].as_bool().is_none() { reclaimable = None; }
        if reason.is_none() { reclaimable = reclaimable.zip(cache["Size"].as_u64()).map(|(sum,size)|sum.saturating_add(size)); }
        json!({"id":id,"label":cache["Description"].as_str().filter(|s|!s.is_empty()).unwrap_or(id),"size":cache["Size"],"createdAt":cache["CreatedAt"],"eligible":reason.is_none(),"reason":reason})
    }).collect();
    let volume_bytes = volume_values.iter().try_fold(0u64, |sum, volume| {
        volume["UsageData"]["Size"]
            .as_u64()
            .map(|size| sum.saturating_add(size))
    });
    let mut warnings = vec!["Docker reclamation is an estimate; shared layers can change actual freed bytes. VHDX file size and Windows reclaimed space are separate measurements.".to_owned(), "Container and volume automatic cleanup is excluded.".to_owned()];
    if !client.cache_supported() {
        warnings.push(format!("Selective build cache cleanup is blocked for Engine {}: Docker API 1.51 is outside its supported API range.",client.server));
    }
    if volume_bytes.is_none() {
        warnings
            .push("Some volume sizes are unavailable; volume usage is shown as unknown.".into());
    }
    json!({"imagesBytes":aggregate_size(usage,"ImageUsage",usage["LayersSize"].as_u64()),"containersBytes":aggregate_size(usage,"ContainerUsage",measured_sum(&container_values,"SizeRw")),"volumesBytes":aggregate_size(usage,"VolumeUsage",volume_bytes),"buildCacheBytes":aggregate_size(usage,"BuildCacheUsage",measured_sum(&caches,"Size")),"reclaimableBytes":reclaimable,"images":images,"buildCache":build_cache,"warnings":warnings})
}
pub fn disk_usage() -> Result<Value, String> {
    let client = connected()?;
    Ok(summarize_usage(
        &client,
        &client.usage()?,
        &client.containers()?,
    ))
}

fn request_ids(
    request: &Value,
    key: &str,
    validator: fn(&str) -> bool,
) -> Result<Vec<String>, String> {
    let Some(values) = request.get(key) else {
        return Ok(Vec::new());
    };
    let values = values
        .as_array()
        .ok_or("Selection must be an array of IDs")?;
    if values.len() > 100 {
        return Err("A maximum of 100 objects can be selected per operation".into());
    }
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        let id = value.as_str().ok_or("Invalid selected ID")?;
        if !validator(id) || !seen.insert(id) {
            return Err("Invalid or duplicate selected ID".into());
        }
        result.push(id.to_owned());
    }
    Ok(result)
}
fn validate_selection(client: &Client, preview: &Preview) -> Result<Option<u64>, String> {
    let info = client.json("GET", "/info")?;
    if text(&info, "ID") != client.identity {
        return Err("Engine identity changed; create a new approval preview".into());
    }
    let containers = client.containers()?;
    let mut estimate = if preview.ids.is_empty() {
        Some(0u64)
    } else {
        None
    };
    for id in &preview.ids {
        let c = containers
            .iter()
            .find(|c| text(c, "Id") == id)
            .ok_or("Selected container no longer exists")?;
        if !["created", "exited", "dead"].contains(&text(c, "State")) {
            return Err("Container deletion blocked: container must be stopped; running, paused and restarting containers are excluded".into());
        }
    }
    if !preview.image_ids.is_empty() || !preview.cache_ids.is_empty() {
        let usage = summarize_usage(client, &client.usage()?, &containers);
        for (ids, key) in [
            (&preview.image_ids, "images"),
            (&preview.cache_ids, "buildCache"),
        ] {
            let candidates = array(&usage, key);
            for id in ids {
                let candidate = candidates
                    .iter()
                    .find(|c| text(c, "id") == id)
                    .ok_or("Selected cleanup object no longer exists")?;
                if candidate["eligible"].as_bool() != Some(true) {
                    return Err(format!(
                        "Cleanup blocked: {}",
                        candidate["reason"]
                            .as_str()
                            .unwrap_or("Object is not eligible")
                    ));
                }
                let size = if key == "images" {
                    candidate["estimatedReclaimableBytes"].as_u64()
                } else {
                    candidate["size"].as_u64()
                };
                estimate = estimate
                    .zip(size)
                    .map(|(sum, size)| sum.saturating_add(size));
            }
        }
    }
    Ok(estimate)
}
fn random_token() -> Result<String, String> {
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut std::ffi::c_void,
            buffer: *mut u8,
            len: u32,
            flags: u32,
        ) -> i32;
    }
    let mut buffer = [0u8; 32];
    if unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            2,
        )
    } != 0
    {
        return Err("Approval token creation failed".into());
    }
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}
pub fn destructive_preview(request: Value) -> Result<Value, String> {
    let _lock = MUTATION.lock().map_err(|_| "Operation lock unavailable")?;
    let kind = request["kind"].as_str().ok_or("Operation kind required")?;
    let ids = request_ids(
        &request,
        "ids",
        if kind == "container_delete" {
            container_id
        } else {
            image_id
        },
    )?;
    let mut image_ids = request_ids(&request, "imageIds", image_id)?;
    let cache_ids = request_ids(&request, "buildCacheIds", cache_id)?;
    match kind {
        "container_delete" if !ids.is_empty() && image_ids.is_empty() && cache_ids.is_empty() => {}
        "image_delete" if !ids.is_empty() && image_ids.is_empty() && cache_ids.is_empty() => {
            image_ids = ids.clone();
        }
        "cleanup" if ids.is_empty() && (!image_ids.is_empty() || !cache_ids.is_empty()) => {}
        _ => return Err("Unsupported or empty destructive selection".into()),
    }
    let client = connected()?;
    let preview = Preview {
        kind: kind.into(),
        ids: if kind == "container_delete" {
            ids
        } else {
            Vec::new()
        },
        image_ids,
        cache_ids,
        expires: now_ms() + 120000,
        identity: client.identity.clone(),
        context: client.context.clone(),
        owner: client.owner.clone(),
    };
    let estimated = validate_selection(&client, &preview)?;
    let targets = preview
        .ids
        .iter()
        .chain(preview.image_ids.iter())
        .chain(preview.cache_ids.iter())
        .cloned()
        .collect::<Vec<_>>();
    let mut impact = vec![
        "Deletion is irreversible within DockSlate.".to_owned(),
        "Existing volumes are retained. Force deletion and system-wide prune are excluded."
            .to_owned(),
    ];
    if kind == "container_delete" {
        impact.push("The stopped container writable layer and configuration will be removed; its image and named/anonymous volumes are retained.".into());
    }
    if !preview.image_ids.is_empty() {
        impact.push("Only selected images are requested for deletion; image metadata and unreferenced layers may be removed. Downloading an image again requires its source registry.".into());
    }
    if !preview.cache_ids.is_empty() {
        impact.push("Only exact selected unused, unshared build cache IDs are requested. Subsequent builds may take longer.".into());
    }
    let token = random_token()?;
    let expires = preview.expires;
    let mut previews = PREVIEWS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Approval state unavailable")?;
    previews.retain(|_, p| p.expires > now_ms());
    if previews.len() >= 20 {
        return Err("Too many pending previews; retry after existing previews expire".into());
    }
    previews.insert(token.clone(), preview);
    Ok(
        json!({"token":token,"kind":kind,"targets":targets,"impact":impact,"recoverable":false,"expiresAt":expires,"estimatedBytes":if kind=="container_delete"{None}else{estimated}}),
    )
}
pub fn destructive_execute(token: String, approved: bool) -> Result<Value, String> {
    if !approved {
        return Err("Explicit user approval is required".into());
    }
    let _lock = MUTATION.lock().map_err(|_| "Operation lock unavailable")?;
    let preview = PREVIEWS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Approval state unavailable")?
        .remove(&token)
        .ok_or("Approval preview is missing or already consumed")?;
    if preview.expires <= now_ms() {
        return Err("Approval preview expired; create a new preview".into());
    }
    let client = connected()?;
    if client.identity != preview.identity
        || client.context != preview.context
        || !client.owner.eq_ignore_ascii_case(&preview.owner)
    {
        return Err(
            "Engine identity or context changed after approval; create a new preview".into(),
        );
    }
    validate_selection(&client, &preview)?;
    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    for id in &preview.ids {
        let selected = Preview {
            ids: vec![id.clone()],
            image_ids: Vec::new(),
            cache_ids: Vec::new(),
            ..preview.clone()
        };
        let result = validate_selection(&client, &selected)
            .and_then(|_| client.json("DELETE", &format!("/containers/{id}?force=0&v=0")));
        match result {
            Ok(_) => deleted.push(id.clone()),
            Err(error) => failed.push(json!({"id":id,"error":error})),
        };
    }
    for id in &preview.image_ids {
        let selected = Preview {
            ids: Vec::new(),
            image_ids: vec![id.clone()],
            cache_ids: Vec::new(),
            ..preview.clone()
        };
        let result = validate_selection(&client, &selected).and_then(|_| {
            client.json(
                "DELETE",
                &format!("/images/{}?force=0&noprune=1", encode(id)),
            )
        });
        match result {
            Ok(_) => deleted.push(id.clone()),
            Err(error) => failed.push(json!({"id":id,"error":error})),
        };
    }
    for id in &preview.cache_ids {
        let selected = Preview {
            ids: Vec::new(),
            image_ids: Vec::new(),
            cache_ids: vec![id.clone()],
            ..preview.clone()
        };
        let filters = encode(&json!({"id":[format!("^{id}$")]}).to_string());
        let result =
            validate_selection(&client, &selected).and_then(|_| client.prune_cache(&filters));
        match result {
            Ok(report) => {
                let removed = array(&report, "CachesDeleted");
                if removed.iter().any(|removed| removed.as_str() != Some(id)) {
                    failed.push(json!({"id":id,"error":"Engine returned an unexpected cache ID; stop cleanup and inspect the engine"}));
                    break;
                }
                if removed.iter().any(|removed| removed.as_str() == Some(id)) {
                    deleted.push(id.clone());
                } else {
                    failed.push(json!({"id":id,"error":"Selected cache was not deleted; it may have become referenced"}));
                }
            }
            Err(error) => failed.push(json!({"id":id,"error":error})),
        }
    }
    Ok(
        json!({"message":format!("{}: {} deleted, {} failed",preview.kind,deleted.len(),failed.len()),"deleted":deleted,"failed":failed}),
    )
}
