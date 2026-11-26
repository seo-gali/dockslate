use super::*;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

#[derive(Deserialize, Serialize)]
pub(super) struct Receipt {
    source: String,
    target: String,
    kind: String,
    id: String,
    generation: Value,
    pub destination: String,
    created: Value,
    token: String,
}
pub(super) fn read() -> Result<Vec<Receipt>, String> {
    let path = directory()?.join("completed.json");
    if !path.exists() { return Ok(vec![]); }
    plain(&path)?;
    let mut bytes = vec![];
    File::open(path).and_then(|file| file.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes))
        .map_err(|_| "이전 완료 기록을 읽을 수 없습니다.")?;
    if bytes.len() > 8 * 1024 * 1024 { return Err("이전 완료 기록 크기 제한을 초과했습니다.".into()); }
    serde_json::from_slice(&bytes).map_err(|_| "이전 완료 기록이 손상되었습니다. 대상 데이터는 변경하지 않았습니다.".into())
}
fn plain(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "이전 기록 경로를 확인할 수 없습니다.")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return Err("이전 기록의 reparse point는 지원하지 않습니다.".into()); }
    }
    if !meta.is_file() || meta.file_type().is_symlink() { return Err("이전 기록은 일반 파일이어야 합니다.".into()); }
    Ok(())
}
pub(super) fn directory() -> Result<PathBuf, String> {
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("현재 사용자의 앱 데이터 경로를 확인할 수 없습니다.")?);
    if !local.is_absolute() || !local.is_dir() { return Err("현재 사용자의 앱 데이터 경로가 올바르지 않습니다.".into()); }
    let root = local.join("DockSlate/migration");
    for parent in root.ancestors().collect::<Vec<_>>().into_iter().rev() {
        if !parent.exists() && parent.starts_with(&local) { fs::create_dir(parent).map_err(|_| "앱의 복사 작업 폴더를 만들 수 없습니다.")?; }
        let meta = fs::symlink_metadata(parent).map_err(|_| "이전 경로를 검사할 수 없습니다.")?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 { return Err("이전 경로의 reparse point는 지원하지 않습니다.".into()); }
        }
        if !meta.is_dir() || meta.file_type().is_symlink() { return Err("이전 경로는 일반 폴더여야 합니다.".into()); }
    }
    Ok(root)
}
fn generation(kind: &str, value: &Value) -> Value {
    if kind == "volumes" { value["CreatedAt"].clone() } else { Value::Null }
}
pub(super) fn find<'a>(receipts: &'a [Receipt], source: &str, target: &str, kind: &str, id: &str, value: &Value, targets: &[Value]) -> Option<&'a Receipt> {
    receipts.iter().rev().find(|receipt| receipt.source == source && receipt.target == target && receipt.kind == kind && receipt.id == id
        && receipt.generation == generation(kind, value)
        && targets.iter().any(|existing| {
            let key = if kind == "containers" { "Id" } else { "Name" };
            existing[key] == receipt.destination && existing["Labels"]["io.dockslate.migration"] == receipt.token
                && generation(if kind == "binds" { "volumes" } else { kind }, existing) == receipt.created
        }))
}
pub(super) fn save(plan: &Plan, kind: &str, id: &str, source: &Value, destination: &Value) -> Result<(), String> {
    if destination["Labels"]["io.dockslate.migration"] != plan.token
        || text(destination, if kind == "containers" { "Id" } else { "Name" }).is_empty()
        || (kind != "containers" && text(destination, "CreatedAt").is_empty())
        || (kind == "volumes" && text(source, "CreatedAt").is_empty())
    { return Err("복사 대상의 소유권·생성 정보를 확인할 수 없어 완료로 기록하지 않았습니다.".into()); }
    let mut receipts = read()?;
    receipts.retain(|receipt| !(receipt.source == plan.source && receipt.target == plan.target && receipt.kind == kind && receipt.id == id));
    receipts.push(Receipt { source: plan.source.clone(), target: plan.target.clone(), kind: kind.into(), id: id.into(), generation: generation(kind, source), destination: text(destination, if kind == "containers" { "Id" } else { "Name" }).into(), created: generation(if kind == "binds" { "volumes" } else { kind }, destination), token: plan.token.clone() });
    let bytes = serde_json::to_vec(&receipts).map_err(|_| "이전 완료 기록을 만들 수 없습니다.")?;
    if bytes.len() > 8 * 1024 * 1024 { return Err("이전 완료 기록 크기 제한을 초과했습니다.".into()); }
    let directory = directory()?;
    let index = directory.join("completed.json");
    if index.exists() { plain(&index)?; }
    let temporary = directory.join(format!("completed-{}.tmp", runtime::new_token()?));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| "이전 완료 기록을 저장할 수 없습니다.")?;
    let result = file.write_all(&bytes).and_then(|_| file.sync_all());
    drop(file);
    if result.and_then(|_| fs::rename(&temporary, &index)).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("복사는 끝났지만 완료 기록을 저장하지 못했습니다. 대상 데이터는 보존했습니다.".into());
    }
    if ["containers", "volumes"].contains(&kind) {
        if let Ok(mut state) = JOB.lock() {
            if let Some(job) = state.as_mut() {
                if !job["imported"].is_array() { job["imported"] = json!([]); }
                job["imported"].as_array_mut().unwrap().push(json!({"kind":kind,"id":id}));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod security_tests {
    use super::*;
    #[test]
    fn completion_requires_exact_engines_source_generation_and_owned_destination() {
        let receipt: Receipt = serde_json::from_value(json!({"source":"desktop","target":"owned","kind":"volumes","id":"data","generation":"source-created","destination":"data","created":"target-created","token":"copy"})).unwrap();
        let target = json!({"Name":"data","CreatedAt":"target-created","Labels":{"io.dockslate.migration":"copy"}});
        let source = json!({"CreatedAt":"source-created"});
        let receipts = [receipt];
        assert!(find(&receipts,"desktop","owned","volumes","data",&source,&[target.clone()]).is_some());
        assert!(find(&receipts,"other","owned","volumes","data",&source,&[target.clone()]).is_none());
        assert!(find(&receipts,"desktop","owned","volumes","data",&json!({"CreatedAt":"recreated"}),&[target.clone()]).is_none());
        let mut changed = target.clone(); changed["CreatedAt"] = json!("recreated");
        assert!(find(&receipts,"desktop","owned","volumes","data",&source,&[changed]).is_none());
        let mut changed = target; changed["Labels"] = json!({});
        assert!(find(&receipts,"desktop","owned","volumes","data",&source,&[changed]).is_none());
        assert!(find(&[],"desktop","owned","volumes","data",&source,&[]).is_none());
    }
}
