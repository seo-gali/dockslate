use crate::{
    docker::{self, Client},
    resources::{approval_token, encode, now_ms, object_id, EngineBinding, APPROVAL_TTL},
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::Instant,
};

static APPROVALS: OnceLock<Mutex<HashMap<String, ImageApproval>>> = OnceLock::new();

struct ImageApproval {
    id: String,
    engine: EngineBinding,
    image: Value,
    containers: BTreeMap<String, Value>,
    cascade: bool,
    created: Instant,
}
fn image_id(id: &str) -> bool {
    id.strip_prefix("sha256:").is_some_and(object_id)
}
fn inspect_image(client: &Client, id: &str) -> Result<Value, String> {
    if !image_id(id) {
        return Err("Invalid image ID".into());
    }
    let mut image = client.json("GET", &format!("/images/{}/json", encode(id)))?;
    if image["Id"].as_str() != Some(id) || image["Os"].as_str() != Some("linux") {
        return Err("Selected Linux image identity could not be verified".into());
    }
    for key in ["RepoTags", "RepoDigests"] {
        if image[key].is_null() {
            image[key] = json!([]);
        }
        let values = image[key]
            .as_array_mut()
            .ok_or("Image references are unavailable")?;
        if values.iter().any(|value| value.as_str().is_none()) {
            return Err("Invalid image reference metadata".into());
        }
        values.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
        values.dedup();
    }
    if let Some(object) = image.as_object_mut() {
        object.remove("Containers");
    }
    Ok(image)
}
fn container_fingerprint(inspect: &Value, id: &str, image: &str) -> Result<Value, String> {
    let state = &inspect["State"];
    let status = state["Status"]
        .as_str()
        .ok_or("Container state is unavailable")?;
    if inspect["Id"].as_str() != Some(id)
        || inspect["Image"].as_str() != Some(image)
        || inspect["Name"].as_str().is_none_or(str::is_empty)
        || status.is_empty()
        || state["Running"].as_bool().is_none()
        || state["Paused"].as_bool().is_none()
        || state["Restarting"].as_bool().is_none()
        || !inspect["Config"].is_object()
        || !inspect["HostConfig"].is_object()
        || !inspect["Mounts"].is_array()
    {
        return Err(
            "Referencing container identity, state or configuration could not be verified".into(),
        );
    }
    Ok(json!({
        "id":id,"name":inspect["Name"].as_str().unwrap_or("").trim_start_matches('/'),
        "state":status,"imageId":image,"created":inspect["Created"],
        "running":state["Running"],"paused":state["Paused"],"restarting":state["Restarting"],
        "config":inspect["Config"],"hostConfig":inspect["HostConfig"],"mounts":inspect["Mounts"]
    }))
}
fn container_eligible(container: &Value) -> bool {
    matches!(
        container["state"].as_str(),
        Some("created" | "exited" | "dead")
    ) && container["running"].as_bool() == Some(false)
        && container["paused"].as_bool() == Some(false)
        && container["restarting"].as_bool() == Some(false)
}
fn referencing_containers(client: &Client, image: &str) -> Result<BTreeMap<String, Value>, String> {
    let mut references = BTreeMap::new();
    let mut seen = HashSet::new();
    for container in client.containers()? {
        let id = container["Id"]
            .as_str()
            .filter(|id| object_id(id))
            .ok_or("Container identity is unavailable; image deletion is blocked")?;
        if !seen.insert(id.to_owned()) {
            return Err("Duplicate container identity; refresh the image list".into());
        }
        let reference = container["ImageID"]
            .as_str()
            .filter(|id| image_id(id))
            .ok_or("Container image identity is unavailable; image deletion is blocked")?;
        if reference != image {
            continue;
        }
        if references.len() >= 100 {
            return Err("A maximum of 100 referencing containers can be approved at once".into());
        }
        let inspect = client.json("GET", &format!("/containers/{id}/json"))?;
        references.insert(id.to_owned(), container_fingerprint(&inspect, id, image)?);
    }
    Ok(references)
}
fn display_containers(containers: &BTreeMap<String, Value>) -> Vec<Value> {
    containers
        .values()
        .map(|value| json!({"id":value["id"],"name":value["name"],"state":value["state"]}))
        .collect()
}
fn validate(
    client: &Client,
    approval: &ImageApproval,
    remaining: &BTreeMap<String, Value>,
) -> Result<(), String> {
    approval.engine.verify(client)?;
    if inspect_image(client, &approval.id)? != approval.image {
        return Err("Image metadata or tags changed; create a new approval preview".into());
    }
    if referencing_containers(client, &approval.id)? != *remaining {
        return Err("The exact referencing container set or container configuration changed; create a new approval preview".into());
    }
    Ok(())
}

pub fn preview(id: String, delete_referencing_containers: bool) -> Result<Value, String> {
    let client = docker::connected()?;
    let image = inspect_image(&client, &id)?;
    let containers = referencing_containers(&client, &id)?;
    let mut blocked_reasons = Vec::new();
    if !containers.is_empty() && !delete_referencing_containers {
        blocked_reasons.push("This image is referenced by existing containers. Explicitly include all stopped referencing containers in a new deletion preview");
    }
    if containers
        .values()
        .any(|container| !container_eligible(container))
    {
        blocked_reasons.push("Image deletion blocked: every referencing container must be verified as created, exited or dead; running, paused, restarting and unknown containers are excluded");
    }
    if image["RepoTags"]
        .as_array()
        .is_some_and(|tags| tags.len() > 1)
    {
        blocked_reasons.push("This image has multiple tags. Deletion by image ID requires force for multiple tags, which DockSlate does not allow");
    }
    let eligible = blocked_reasons.is_empty();
    let token = if eligible {
        Some(approval_token()?)
    } else {
        None
    };
    let visible_containers = display_containers(&containers);
    let targets: Vec<_> = containers
        .keys()
        .cloned()
        .chain(std::iter::once(id.clone()))
        .collect();
    let response = json!({
        "token":token,"kind":"image_delete","targets":targets,
        "eligible":eligible,"blockedReasons":blocked_reasons,
        "image":{"id":id,"tags":image["RepoTags"],"size":image["Size"]},
        "containers":visible_containers,"deleteReferencingContainers":delete_referencing_containers,
        "impact":["Only the exact listed stopped containers and selected image are approved for deletion. Running, paused and restarting containers are blocked.","Container writable layers and configuration will be irreversibly removed. All named and anonymous volumes are retained.","The selected image tags, metadata and unreferenced layers may be removed. Parent images are retained. Downloading the image again requires its source registry.","This is a sequence of Docker operations. A later failure can leave already deleted containers removed while the image is retained."],
        "recoverable":false,"expiresAt":token.as_ref().map(|_|now_ms()+APPROVAL_TTL.as_millis() as u64),"estimatedBytes":null
    });
    let Some(token) = token else {
        return Ok(response);
    };
    let mut approvals = APPROVALS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Image approval state unavailable")?;
    approvals.retain(|_, value| value.created.elapsed() < APPROVAL_TTL && value.id != id);
    if approvals.len() >= 100 {
        return Err(
            "Too many pending image previews; wait for an existing preview to expire".into(),
        );
    }
    approvals.insert(
        token,
        ImageApproval {
            id,
            engine: EngineBinding::capture(&client),
            image,
            containers,
            cascade: delete_referencing_containers,
            created: Instant::now(),
        },
    );
    Ok(response)
}

pub fn execute(token: String, approved: bool) -> Result<Value, String> {
    if !object_id(&token) {
        return Err("Invalid image approval token".into());
    }
    let approval = APPROVALS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Image approval state unavailable")?
        .remove(&token)
        .ok_or("Image approval is missing or already consumed")?;
    if !approved {
        return Err("Explicit user approval is required".into());
    }
    if approval.created.elapsed() >= APPROVAL_TTL {
        return Err("Image approval expired; create a new preview".into());
    }
    if !approval.cascade && !approval.containers.is_empty() {
        return Err("Container deletion was not explicitly included in the approval".into());
    }
    if approval
        .containers
        .values()
        .any(|container| !container_eligible(container))
    {
        return Err("The approved container set contains an active or unverified container".into());
    }
    let client = docker::connected()?;
    let mut remaining = approval.containers.clone();
    validate(&client, &approval, &remaining)?;
    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    for id in approval.containers.keys() {
        let result = validate(&client, &approval, &remaining)
            .and_then(|_| client.json("DELETE", &format!("/containers/{id}?force=0&v=0")));
        match result {
            Ok(_) => {
                deleted.push(id.clone());
                remaining.remove(id);
            }
            Err(error) => {
                failed.push(json!({"id":id,"error":error}));
                break;
            }
        }
    }
    if failed.is_empty() {
        let result = validate(&client, &approval, &remaining).and_then(|_| {
            client.json(
                "DELETE",
                &format!("/images/{}?force=0&noprune=1", encode(&approval.id)),
            )
        });
        match result {
            Ok(_) => deleted.push(approval.id.clone()),
            Err(error) => failed.push(json!({"id":approval.id,"error":error})),
        }
    }
    let skipped: Vec<_> = remaining
        .keys()
        .cloned()
        .chain((!deleted.contains(&approval.id)).then_some(approval.id.clone()))
        .collect();
    Ok(json!({
        "message":format!("Image deletion: {} deleted, {} failed",deleted.len(),failed.len()),
        "deleted":deleted,"failed":failed,"remaining":skipped,"volumesRetained":true
    }))
}
