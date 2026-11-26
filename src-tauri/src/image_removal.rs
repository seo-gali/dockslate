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
pub(crate) fn inspect_image(client: &Client, id: &str) -> Result<Value, String> {
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
        object.remove("Metadata");
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
    let containers = client.containers()?;
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    for container in &containers {
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
        if ids.len() >= 100 {
            return Err("A maximum of 100 referencing containers can be approved at once".into());
        }
        ids.push(id);
    }
    let mut results: [Option<Result<Value, String>>; 100] = std::array::from_fn(|_| None);
    std::thread::scope(|scope| {
        let mut workers = [None, None, None, None];
        let chunk = ids.len().div_ceil(4).max(1);
        for (index, (results, ids)) in results[..ids.len()].chunks_mut(chunk).zip(ids.chunks(chunk)).enumerate() {
            workers[index] = Some(scope.spawn(move || {
                for (result, id) in results.iter_mut().zip(ids) {
                    *result = Some(client.json("GET", &format!("/containers/{id}/json")).and_then(|inspect| container_fingerprint(&inspect, id, image)));
                }
            }));
        }
        for worker in workers.into_iter().flatten() { let _ = worker.join(); }
    });
    let mut references = BTreeMap::new();
    for (id, result) in ids.into_iter().zip(results) {
        references.insert(id.to_owned(), result.ok_or("Container inspect worker failed; image deletion is blocked")??);
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

fn remove_references(
    approved: &Value,
    mut inspect: impl FnMut() -> Result<Option<Value>, String>,
    mut delete: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let mut previous = approved.clone();
    loop {
        let Some(current) = inspect()? else { return Ok(()); };
        let mut expected = previous.clone();
        for key in ["RepoTags", "RepoDigests"] {
            if current[key].as_array().is_none_or(|references| references.iter().any(|reference| !previous[key].as_array().is_some_and(|allowed| allowed.contains(reference)))) {
                return Err("Image references changed; create a new approval preview".into());
            }
            expected[key] = current[key].clone();
        }
        if current != expected {
            return Err("Image metadata changed; create a new approval preview".into());
        }
        let reference = current["RepoTags"].as_array().and_then(|values| values.first())
            .or_else(|| current["RepoDigests"].as_array().and_then(|values| values.first()))
            .and_then(Value::as_str).unwrap_or_else(|| current["Id"].as_str().unwrap_or("")).to_owned();
        delete(&reference)?;
        previous = current;
        for key in ["RepoTags", "RepoDigests"] {
            previous[key].as_array_mut().unwrap().retain(|value| value.as_str() != Some(reference.as_str()));
        }
        if reference == approved["Id"].as_str().unwrap_or("") {
            return if inspect()?.is_none() { Ok(()) } else { Err("Image was not removed; refresh the image list".into()) };
        }
    }
}

pub(crate) fn delete_unreferenced(client: &Client, image: &Value) -> Result<(), String> {
    let id = image["Id"].as_str().ok_or("Image identity is unavailable")?;
    let engine = EngineBinding::capture(client);
    remove_references(image, || {
        engine.verify(client)?;
        if !referencing_containers(client, id)?.is_empty() {
            return Err("Image is referenced by an existing container; create a new approval preview".into());
        }
        let images = client.json("GET", "/images/json?all=1")?;
        if !images.as_array().ok_or("Image inventory is unavailable")?.iter().any(|value| value["Id"].as_str() == Some(id)) { return Ok(None); }
        inspect_image(client, id).map(Some)
    }, |reference| client.json("DELETE", &format!("/images/{}?force=0&noprune=1", encode(reference))).map(|_| ()))
}

pub fn preview(id: String, delete_referencing_containers: bool) -> Result<Value, String> {
    if !image_id(&id) { return Err("Invalid image ID".into()); }
    let client = docker::connected()?;
    let (image, containers) = std::thread::scope(|scope| {
        let image = scope.spawn(|| inspect_image(&client, &id));
        let containers = referencing_containers(&client, &id);
        (image.join().unwrap_or_else(|_| Err("Image preview worker failed.".into())), containers)
    });
    let (image, containers) = (image?, containers?);
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
        "image":{"id":id,"tags":image["RepoTags"],"digests":image["RepoDigests"],"size":image["Size"]},
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
        let result = validate(&client, &approval, &remaining)
            .and_then(|_| delete_unreferenced(&client, &approval.image));
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

#[cfg(test)]
mod security_tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn multiple_tags_are_removed_without_force_and_new_tags_block() {
        let image = json!({"Id":"sha256:test","RepoTags":["gitlab/gitlab-ce:18.11.2-ce.0","gitlab/gitlab-ce:latest"],"RepoDigests":["gitlab/gitlab-ce@sha256:digest"],"Os":"linux"});
        let state = RefCell::new(Some(image.clone()));
        let mut deleted = Vec::new();
        remove_references(&image, || Ok(state.borrow().clone()), |reference| {
            deleted.push(reference.to_owned());
            let mut current = state.borrow_mut();
            current.as_mut().unwrap()["RepoTags"].as_array_mut().unwrap().retain(|tag| tag.as_str() != Some(reference));
            if current.as_ref().unwrap()["RepoTags"].as_array().unwrap().is_empty() { *current = None; }
            Ok(())
        }).unwrap();
        assert_eq!(deleted, ["gitlab/gitlab-ce:18.11.2-ce.0", "gitlab/gitlab-ce:latest"]);
        let mut changed = image.clone();
        changed["RepoTags"].as_array_mut().unwrap().push(json!("gitlab/gitlab-ce:new"));
        assert!(remove_references(&image, || Ok(Some(changed.clone())), |_| panic!("Changed tags must block deletion")).is_err());
        assert!(remove_references(&image, || Ok(Some(image.clone())), |_| Err("Referenced by a container".into())).is_err());
    }

    #[test]
    fn digest_only_and_dangling_images_use_exact_references_and_stop_on_partial_changes() {
        for references in [vec!["repo@sha256:first", "other@sha256:second"], vec![]] {
            let image = json!({"Id":"sha256:test","RepoTags":[],"RepoDigests":references,"Os":"linux"});
            let state = RefCell::new(Some(image.clone()));
            let mut removed = vec![];
            remove_references(&image, || Ok(state.borrow().clone()), |reference| {
                removed.push(reference.to_owned());
                let mut current = state.borrow_mut();
                if reference == "sha256:test" { *current = None; }
                else { current.as_mut().unwrap()["RepoDigests"].as_array_mut().unwrap().retain(|value| value.as_str() != Some(reference)); }
                Ok(())
            }).unwrap();
            assert_eq!(removed.last().map(String::as_str), Some("sha256:test"));
        }
        let image = json!({"Id":"sha256:test","RepoTags":["repo:first","repo:second"],"RepoDigests":[],"Os":"linux"});
        let state = RefCell::new(image.clone());
        let mut calls = 0;
        assert!(remove_references(&image, || Ok(Some(state.borrow().clone())), |_| {
            calls += 1;
            state.borrow_mut()["RepoTags"] = json!(["repo:second","repo:unexpected"]);
            Ok(())
        }).is_err());
        assert_eq!(calls, 1);
    }
}
