use crate::runtime::Transport;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const ENDPOINT: &str = "wsl://DockSlate/var/run/docker.sock";
const BODY_LIMIT: usize = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
static MUTATION: Mutex<()> = Mutex::new(());
static PREVIEWS: OnceLock<Mutex<HashMap<String, Preview>>> = OnceLock::new();

#[derive(Clone)]
struct Client {
    transport: Transport,
    context: String,
    owner: String,
    api: String,
    server: String,
    identity: String,
    cache_api_supported: bool,
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
    fn bytes(
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
    fn json(&self, method: &str, path: &str) -> Result<Value, String> {
        let body = self.bytes(method, path, REQUEST_TIMEOUT, BODY_LIMIT)?;
        if body.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&body).map_err(|_| "Invalid Docker JSON response".into())
    }
    fn containers(&self) -> Result<Vec<Value>, String> {
        self.json("GET", "/containers/json?all=1")?
            .as_array()
            .cloned()
            .ok_or_else(|| "Invalid Docker container list".into())
    }
    fn images(&self) -> Result<Vec<Value>, String> {
        self.json("GET", "/images/json?all=0&shared-size=1")?
            .as_array()
            .cloned()
            .ok_or_else(|| "Invalid Docker image list".into())
    }
    fn usage(&self) -> Result<Value, String> {
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
fn connected() -> Result<Client, String> {
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
    pub(crate) fn spawn(
        &self,
        context: &str,
        dockerfile: &str,
        tag: &str,
        no_cache: bool,
    ) -> Result<std::process::Child, String> {
        self.verify_identity()?;
        self.0
            .transport
            .spawn_image_build(context, dockerfile, tag, no_cache)
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
    json!({"engine_status":engine,"overview":error,"containers_list":error,"images_list":error,"disk_usage":error})
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
    let (containers, images, usage) = std::thread::scope(|scope| {
        let containers = scope.spawn(|| client.containers());
        let images = scope.spawn(|| client.images());
        let usage = scope.spawn(|| client.usage());
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
        )
    });
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
    json!({"engine_status":engine_status,"overview":overview,"containers_list":container_list,"images_list":image_list,"disk_usage":disk_usage})
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
        json!({"id":c["Id"],"name":name,"image":c["Image"],"state":c["State"],"status":c["Status"],"ports":ports,"composeProject":c["Labels"]["com.docker.compose.project"].as_str()})
    }).collect();
    json!(items)
}
pub fn container_action(id: String, action: String) -> Result<Value, String> {
    let _lock = MUTATION.lock().map_err(|_| "Operation lock unavailable")?;
    if !container_id(&id) || !["start", "stop", "restart"].contains(&action.as_str()) {
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
    let query = if action == "start" {
        String::new()
    } else {
        "?t=10".into()
    };
    client.json("POST", &format!("/containers/{id}/{action}{query}"))?;
    Ok(json!({"message":format!("Container {action} completed")}))
}
pub fn container_logs(id: String) -> Result<Value, String> {
    if !container_id(&id) {
        return Err("Invalid container ID".into());
    }
    let client = connected()?;
    if !client.containers()?.iter().any(|c| text(c, "Id") == id) {
        return Err("Container no longer exists".into());
    }
    let inspect = client.json("GET", &format!("/containers/{id}/json"))?;
    let body = client.bytes(
        "GET",
        &format!("/containers/{id}/logs?stdout=1&stderr=1&timestamps=1&tail=300&follow=0"),
        REQUEST_TIMEOUT,
        4 * 1024 * 1024,
    )?;
    let mut content = Vec::new();
    if inspect["Config"]["Tty"].as_bool() == Some(true) {
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
    let values: Vec<_> = images.iter().map(|image| {
        let id = text(image, "Id");
        let references = containers.iter().filter(|c| text(c, "ImageID") == id).count();
        let tags: Vec<_> = array(image, "RepoTags").into_iter().filter(|tag| tag.as_str() != Some("<none>:<none>")).collect();
        json!({"id":id,"tags":tags,"size":image["Size"],"containers":references,"created":image["Created"]})
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
    let client = connected()?;
    let body = client.bytes(
        "POST",
        &format!("/images/create?fromImage={}", encode(&reference)),
        Duration::from_secs(120),
        32 * 1024 * 1024,
    )?;
    let mut statuses = Vec::new();
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
            statuses.push(status.chars().take(300).collect::<String>());
        }
    }
    let final_status = statuses
        .last()
        .ok_or("Image pull returned no completion response")?;
    let image = client.json("GET", &format!("/images/{}/json", encode(&reference)))?;
    if !image_id(text(&image, "Id")) {
        return Err(format!("Pull response completed ({final_status}), but the requested image identity could not be verified"));
    }
    Ok(json!({"message":format!("Image pull completed: {final_status}")}))
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
    let image_values = array(usage, "Images");
    let container_values = array(usage, "Containers");
    let volume_values = array(usage, "Volumes");
    let caches = array(usage, "BuildCache");
    let mut reclaimable = Some(0u64);
    let images: Vec<_> = image_values.iter().map(|image| {
        let id = text(image,"Id");
        let referenced = containers.iter().any(|container| text(container,"ImageID") == id);
        let eligible = image_id(id) && !referenced;
        let unique = image["Size"].as_u64().zip(image["SharedSize"].as_u64()).map(|(size,shared)|size.saturating_sub(shared));
        if eligible { reclaimable = reclaimable.zip(unique).map(|(sum,unique)|sum.saturating_add(unique)); }
        let label = array(image,"RepoTags").iter().filter_map(Value::as_str).filter(|tag| *tag != "<none>:<none>").collect::<Vec<_>>().join(", ");
        json!({"id":id,"label":if label.is_empty(){id.to_owned()}else{label},"size":image["Size"],"eligible":eligible,"reason":if referenced {Some("Referenced by an existing container")} else if !image_id(id) {Some("Invalid image identity")} else {None},"estimatedReclaimableBytes":unique})
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
        json!({"id":id,"label":cache["Description"].as_str().filter(|s|!s.is_empty()).unwrap_or(id),"size":cache["Size"],"eligible":reason.is_none(),"reason":reason})
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
