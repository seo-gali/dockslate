use crate::docker::{self, Client};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(crate) const APPROVAL_TTL: Duration = Duration::from_secs(120);
static APPROVALS: OnceLock<Mutex<HashMap<String, NetworkApproval>>> = OnceLock::new();

pub(crate) struct EngineBinding {
    identity: String,
    owner: String,
    context: String,
    api: String,
}
impl EngineBinding {
    pub(crate) fn capture(client: &Client) -> Self {
        Self {
            identity: client.identity.clone(),
            owner: client.transport.owner.clone(),
            context: client.transport.context.clone(),
            api: client.api.clone(),
        }
    }
    pub(crate) fn verify(&self, client: &Client) -> Result<(), String> {
        if self.identity != client.identity
            || !self.owner.eq_ignore_ascii_case(&client.transport.owner)
            || self.context != client.transport.context
            || self.api != client.api
            || client.json("GET", "/info")?["ID"].as_str() != Some(&self.identity)
        {
            return Err(
                "Engine identity or runtime ownership changed; create a new approval preview"
                    .into(),
            );
        }
        Ok(())
    }
}

struct NetworkApproval {
    id: String,
    engine: EngineBinding,
    fingerprint: Value,
    references: Value,
    created: Instant,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn object_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
pub(crate) fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
#[cfg(windows)]
pub(crate) fn approval_token() -> Result<String, String> {
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut std::ffi::c_void,
            buffer: *mut u8,
            length: u32,
            flags: u32,
        ) -> i32;
    }
    let mut bytes = [0u8; 32];
    if unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), 32, 2) } < 0 {
        return Err("Approval token creation failed".into());
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
#[cfg(not(windows))]
pub(crate) fn approval_token() -> Result<String, String> {
    Err("This operation requires Windows".into())
}

fn builtin(network: &Value) -> bool {
    matches!(network["Name"].as_str(), Some("bridge" | "host" | "none"))
        || network["Labels"]["com.docker.network.bridge.default_bridge"].as_str() == Some("true")
}
fn fingerprint(network: &Value) -> Value {
    let mut value = network.clone();
    if let Some(object) = value.as_object_mut() {
        object.remove("Containers");
    }
    value
}
fn inspect_network(client: &Client, id: &str) -> Result<Value, String> {
    if !object_id(id) {
        return Err("Invalid network ID".into());
    }
    let network = client.json("GET", &format!("/networks/{id}"))?;
    if network["Id"].as_str() != Some(id) || network["Name"].as_str().is_none_or(str::is_empty) {
        return Err("Network identity could not be verified".into());
    }
    Ok(network)
}
fn container_name(container: &Value) -> Result<String, String> {
    let names = container["Names"]
        .as_array()
        .ok_or("Container names are unavailable; network references cannot be verified")?;
    let mut names: Vec<_> = names
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|name| !name.is_empty())
                .map(|name| name.trim_start_matches('/').to_owned())
                .ok_or("Invalid container name")
        })
        .collect::<Result<_, _>>()?;
    names.sort();
    names.dedup();
    if names.is_empty() {
        return Err("Container name is unavailable; network references cannot be verified".into());
    }
    Ok(names.join(", "))
}
fn matches_network(value: &str, id: &str, name: &str) -> bool {
    value == name
        || (!value.is_empty()
            && value.len() <= id.len()
            && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            && id.starts_with(value))
}
fn references(network: &Value, containers: &[Value], inspected: bool) -> Result<Value, String> {
    let id = network["Id"].as_str().ok_or("Network ID is unavailable")?;
    let name = network["Name"]
        .as_str()
        .ok_or("Network name is unavailable")?;
    let mut found = BTreeMap::new();
    let mut seen = HashSet::new();
    for container in containers {
        let container_id = container["Id"]
            .as_str()
            .filter(|id| object_id(id))
            .ok_or("Invalid container identity; network references cannot be verified")?;
        if !seen.insert(container_id) {
            return Err("Duplicate container identity; refresh the resource list".into());
        }
        let networks = container["NetworkSettings"]["Networks"]
            .as_object()
            .ok_or("Container network attachments are unavailable; deletion is blocked")?;
        let mode = container["HostConfig"]["NetworkMode"]
            .as_str()
            .ok_or("Container network mode is unavailable; deletion is blocked")?;
        let attached = networks
            .iter()
            .try_fold(false, |matched, (key, attachment)| {
                let network_id = attachment["NetworkID"]
                    .as_str()
                    .ok_or("Container network identity is unavailable; deletion is blocked")?;
                Ok::<_, String>(matched || network_id == id || matches_network(key, id, name))
            })?;
        if attached || matches_network(mode, id, name) || (mode == "default" && name == "bridge") {
            let state = container["State"]
                .as_str()
                .filter(|state| !state.is_empty())
                .ok_or("Container state is unavailable; network references cannot be verified")?;
            found.insert(
                container_id.to_owned(),
                json!({"id":container_id,"name":container_name(container)?,"state":state}),
            );
        }
    }
    if inspected && !network["Containers"].is_object() {
        return Err("Network endpoint references are unavailable; deletion is blocked".into());
    }
    for (container_id, endpoint) in network["Containers"].as_object().into_iter().flatten() {
        if !object_id(container_id) {
            return Err("Invalid network endpoint identity; deletion is blocked".into());
        }
        found.entry(container_id.clone()).or_insert_with(|| {
            json!({"id":container_id,"name":endpoint["Name"].as_str().unwrap_or(container_id),"state":"unknown"})
        });
    }
    Ok(json!(found.into_values().collect::<Vec<_>>()))
}
fn deletion_block(network: &Value, references: &Value) -> Option<&'static str> {
    if builtin(network) {
        Some("Built-in networks cannot be deleted")
    } else if references.as_array().is_none_or(|items| !items.is_empty()) {
        Some("Network is referenced by containers; remove its container references first")
    } else if network["Scope"].as_str() != Some("local")
        || network["ConfigOnly"].as_bool() != Some(false)
        || network["Ingress"].as_bool() != Some(false)
        || network["Driver"].as_str().is_none_or(str::is_empty)
        || network["Internal"].as_bool().is_none()
        || !network["IPAM"].is_object()
    {
        Some("Only verified local, non-ingress, non-config networks can be deleted")
    } else {
        None
    }
}
fn row(network: &Value, references: &Value) -> Value {
    let reason = deletion_block(network, references);
    json!({
        "id":network["Id"],"name":network["Name"],"driver":network["Driver"],
        "scope":network["Scope"],"internal":network["Internal"],"builtin":builtin(network),
        "ipam":network["IPAM"],"containers":references,"deletable":reason.is_none(),
        "deleteBlockedReason":reason
    })
}

pub(crate) fn networks_from_snapshot(
    client: &Client,
    containers: &[Value],
) -> Result<Value, String> {
    let networks = client.json("GET", "/networks")?;
    networks_from_values(&networks, containers)
}
pub(crate) fn networks_from_values(
    networks: &Value,
    containers: &[Value],
) -> Result<Value, String> {
    let networks = networks.as_array().ok_or("Invalid Docker network list")?;
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for network in networks {
        let id = network["Id"]
            .as_str()
            .filter(|id| object_id(id))
            .ok_or("Network ID is unavailable")?;
        if !seen.insert(id) {
            return Err("Duplicate network identity; refresh the resource list".into());
        }
        if network["Name"].as_str().is_none_or(str::is_empty) {
            return Err("Network name is unavailable".into());
        }
        let references = references(network, containers, false)?;
        result.push(row(network, &references));
    }
    result.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    Ok(json!(result))
}
pub fn networks_list() -> Result<Value, String> {
    let client = docker::connected()?;
    networks_from_snapshot(&client, &client.containers()?)
}

pub fn network_delete_preview(id: String) -> Result<Value, String> {
    let client = docker::connected()?;
    let network = inspect_network(&client, &id)?;
    let references = references(&network, &client.containers()?, true)?;
    if let Some(reason) = deletion_block(&network, &references) {
        return Err(reason.into());
    }
    let token = approval_token()?;
    let mut approvals = APPROVALS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Network approval state unavailable")?;
    approvals.retain(|_, value| value.created.elapsed() < APPROVAL_TTL && value.id != id);
    if approvals.len() >= 20 {
        return Err(
            "Too many pending network previews; wait for an existing preview to expire".into(),
        );
    }
    approvals.insert(
        token.clone(),
        NetworkApproval {
            id: id.clone(),
            engine: EngineBinding::capture(&client),
            fingerprint: fingerprint(&network),
            references: references.clone(),
            created: Instant::now(),
        },
    );
    Ok(json!({
        "token":token,"kind":"network_delete","targets":[id],"network":row(&network,&references),
        "impact":["Only this unused network configuration will be deleted. Containers, images and volumes are retained.","This action cannot be undone within DockSlate. Recreating the network may assign a different ID or subnet."],
        "recoverable":false,"expiresAt":now_ms()+APPROVAL_TTL.as_millis() as u64,"estimatedBytes":null
    }))
}

pub fn network_delete_execute(token: String, approved: bool) -> Result<Value, String> {
    if !object_id(&token) {
        return Err("Invalid network approval token".into());
    }
    let approval = APPROVALS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Network approval state unavailable")?
        .remove(&token)
        .ok_or("Network approval is missing or already consumed")?;
    if !approved {
        return Err("Explicit user approval is required".into());
    }
    if approval.created.elapsed() >= APPROVAL_TTL {
        return Err("Network approval expired; create a new preview".into());
    }
    let client = docker::connected()?;
    approval.engine.verify(&client)?;
    let network = inspect_network(&client, &approval.id)?;
    let references = references(&network, &client.containers()?, true)?;
    if fingerprint(&network) != approval.fingerprint || references != approval.references {
        return Err(
            "Network configuration or container references changed; create a new approval preview"
                .into(),
        );
    }
    if let Some(reason) = deletion_block(&network, &references) {
        return Err(reason.into());
    }
    approval.engine.verify(&client)?;
    client.json("DELETE", &format!("/networks/{}", approval.id))?;
    Ok(json!({"message":"Network deleted","deleted":[approval.id],"failed":[]}))
}
