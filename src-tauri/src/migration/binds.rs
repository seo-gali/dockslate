use super::*;
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};

#[derive(Clone, Serialize)]
pub(super) struct Copy {
    pub source: String,
    pub volume: String,
}
const SUBPATH: &str = "__dockslate_transfer";
fn linux_path(path: &str) -> bool {
    path.starts_with('/')
        && path != "/"
        && !path.chars().any(char::is_control)
        && path[1..]
            .split('/')
            .all(|v| !v.is_empty() && v != "." && v != "..")
}
pub(super) fn valid(mount: &Value) -> bool {
    let source = text(mount, "Source");
    !source.is_empty()
        && source != "/"
        && !source.chars().any(char::is_control)
        && !source.split('/').any(|v| v == "." || v == "..")
        && linux_path(text(mount, "Destination"))
        && ["", "private", "rprivate"].contains(&text(mount, "Propagation"))
}
pub(super) fn socket(mount: &Value) -> bool {
    mount["Type"] == "bind"
        && [
            "/var/run/docker.sock",
            "/run/docker.sock",
            "/run/host-services/docker.proxy.sock",
        ]
        .contains(&text(mount, "Source"))
}
fn relative<'a>(root: &str, child: &'a str) -> Option<&'a str> {
    if root == child {
        Some("")
    } else {
        child.strip_prefix(root)?.strip_prefix('/')
    }
}
pub(super) fn overlaps(a: &str, b: &str) -> bool {
    relative(a, b).is_some() || relative(b, a).is_some()
}
pub(super) fn plan(containers: &[Value], token: &str) -> Result<Vec<Copy>, String> {
    let mut copies: Vec<Copy> = Vec::new();
    for container in containers {
        for mount in array(&container["Mounts"])
            .iter()
            .filter(|m| m["Type"] == "bind" && !socket(m))
        {
            if !valid(mount) {
                return Err("복사할 폴더 연결 경로가 올바르지 않습니다.".into());
            }
            let source = text(mount, "Source");
            if copies.iter().any(|v| relative(&v.source, source).is_some()) {
                continue;
            }
            copies.retain(|v| relative(source, &v.source).is_none());
            copies.push(Copy {
                source: source.into(),
                volume: String::new(),
            });
        }
    }
    copies.sort_by(|a, b| a.source.cmp(&b.source));
    for (index, binding) in copies.iter_mut().enumerate() {
        binding.volume = format!("dockslate-import-{token}-bind-{index}");
    }
    Ok(copies)
}
pub(super) fn mount(mount: &Value, copies: &[Copy]) -> Result<Value, String> {
    if !valid(mount) {
        return Err("폴더 연결 경로가 올바르지 않습니다.".into());
    }
    if socket(mount) {
        return Ok(
            json!({"Type":"bind","Source":"/var/run/docker.sock","Target":mount["Destination"],"ReadOnly":mount["RW"]==false}),
        );
    }
    for copy in copies {
        if let Some(tail) = relative(&copy.source, text(mount, "Source")) {
            if tail.split('/').any(|v| v == "." || v == "..") {
                return Err("폴더 하위 경로를 지원하지 않습니다.".into());
            }
            let subpath = if tail.is_empty() {
                SUBPATH.into()
            } else {
                format!("{SUBPATH}/{tail}")
            };
            return Ok(
                json!({"Type":"volume","Source":copy.volume,"Target":mount["Destination"],"ReadOnly":mount["RW"]==false,"VolumeOptions":{"NoCopy":true,"Subpath":subpath}}),
            );
        }
    }
    Err("승인한 폴더 복사 계획이 없습니다. 다시 검사하세요.".into())
}
fn check_archive_root(archive: &mut File) -> Result<(), String> {
    archive
        .seek(SeekFrom::Start(0))
        .map_err(|_| "복사 tar를 읽을 수 없습니다.")?;
    for _ in 0..32 {
        let mut header = [0u8; 512];
        archive
            .read_exact(&mut header)
            .map_err(|_| "폴더 복사 tar가 비어 있거나 올바르지 않습니다.")?;
        match header[156] {
            0|b'0'|b'5' => {
                let root=std::str::from_utf8(&header[..100]).map_err(|_| "tar 원본 경로를 읽을 수 없습니다.")?.trim_end_matches('\0').trim_end_matches('/').trim_start_matches("./");
                if root != SUBPATH { return Err("tar의 파일·폴더 경로가 복사 대상과 다릅니다.".into()); }
                archive.seek(SeekFrom::Start(0)).map_err(|_| "복사 tar를 다시 열 수 없습니다.")?;return Ok(());
            }
            b'x'|b'g'|b'L'|b'K' => {
                let size=std::str::from_utf8(&header[124..136]).ok().and_then(|v| u64::from_str_radix(v.trim_matches(['\0',' ']),8).ok()).filter(|v| *v<=1024*1024).ok_or("tar 메타데이터 크기를 지원하지 않습니다.")?;
                archive.seek(SeekFrom::Current((size.div_ceil(512)*512) as i64)).map_err(|_| "tar 메타데이터를 읽을 수 없습니다.")?;
            }
            _ => return Err("폴더 연결의 원본이 일반 파일·디렉터리가 아닙니다. 심볼릭 링크·장치·소켓은 파일 복사로 이전하지 않습니다.".into()),
        }
    }
    Err("폴더 복사 tar의 메타데이터가 너무 많습니다.".into())
}
fn users(binding: &Copy) -> Result<Vec<Value>, String> {
    let mut rows: Vec<_> = source_users()?
        .into_iter()
        .filter(|v| {
            array(&v["Mounts"])
                .iter()
                .any(|m| m["Type"] == "bind" && overlaps(&binding.source, text(m, "Source")))
        })
        .collect();
    rows.sort_by(|a, b| text(a, "Id").cmp(text(b, "Id")));
    if rows.iter().any(|v| !stopped(v)) {
        return Err(format!(
            "{}: 원본 폴더를 사용하는 컨테이너가 실행 중입니다.",
            binding.source
        ));
    }
    Ok(rows)
}
fn bind_helper_args(source: &str, image: &Value, token: &str) -> Result<Vec<String>, String> {
    let mut args = helper_args("preview", image, token, true)?;
    let source_mount = args
        .iter_mut()
        .find(|v| v.starts_with("type=volume,src=preview,"))
        .ok_or("폴더 복사 도구의 연결 설정이 없습니다.")?;
    *source_mount = format!(
        "type=bind,\"src={}\",dst=/{SUBPATH},readonly",
        source.replace('"', "\"\"")
    );
    Ok(args)
}
pub(super) fn copy(
    plan: &Plan,
    target: &Client,
    binding: &Copy,
    destination: &str,
    workspace: &mut Workspace,
) -> Result<(), String> {
    same_engines(plan, target)?;
    let before = users(binding)?;
    update(format!("폴더·파일 복사: {}", binding.source), None, false);
    let image = plan.images.first().ok_or("폴더 복사 이미지가 없습니다.")?;
    let (path, mut archive) = workspace.archive()?;
    let args = bind_helper_args(&binding.source, image, &plan.token)?;
    let output = command(SOURCE, &args, Duration::from_secs(30))?;
    let source_helper = std::str::from_utf8(&output)
        .map_err(|_| "원본 복사 도구 ID를 읽을 수 없습니다.")?
        .trim()
        .to_owned();
    if !id(&source_helper) {
        return Err("원본 복사 도구 ID가 올바르지 않습니다.".into());
    }
    let mut target_helper = None;
    let result = (|| {
        copy_file(
            SOURCE,
            &[
                "container".into(),
                "cp".into(),
                "--archive".into(),
                format!("{source_helper}:/{SUBPATH}"),
                "-".into(),
            ],
            &archive,
            false,
        )?;
        check_archive_root(&mut archive)?;
        let mut after = users(binding)?;
        after.retain(|v| v["Id"] != source_helper);
        if before != after {
            return Err("폴더 복사 중 원본 연결·실행 상태가 변경되었습니다.".into());
        }
        same_engines(plan, target)?;
        create_owned_volume(
            target,
            &binding.volume,
            &json!({"io.dockslate.migration.source":binding.source}),
            &plan.token,
        )?;
        update(
            "새 볼륨에 폴더 데이터를 복사합니다.".into(),
            Some(format!("폴더 볼륨 {} (복사 중)", binding.volume)),
            false,
        );
        let helper = create_helper(destination, &binding.volume, image, &plan.token, false)?;
        target_helper = Some(helper.clone());
        drop(archive);
        let input = File::open(&path).map_err(|_| "폴더 복사 tar를 열 수 없습니다.")?;
        copy_file(
            destination,
            &[
                "container".into(),
                "cp".into(),
                "--archive".into(),
                "-".into(),
                format!("{helper}:/__dockslate_transfer"),
            ],
            &input,
            true,
        )
    })();
    for (host, helper, engine) in [
        (SOURCE, Some(source_helper), plan.source.as_str()),
        (destination, target_helper, plan.target.as_str()),
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
        "폴더·파일을 복사했습니다.".into(),
        Some(format!("폴더 {} → {}", binding.source, binding.volume)),
        false,
    );
    Ok(())
}

#[cfg(test)]
mod security_tests {
    use super::*;
    #[test]
    fn bind_plan_preserves_shared_nested_paths_and_file_mounts() {
        let mount = |source, destination| json!({"Type":"bind","Source":source,"Destination":destination,"RW":false});
        let containers = vec![
            json!({"Id":"a".repeat(64),"Mounts":[mount("/host/data/config.yaml","/file.yaml"),mount("/host/data","/directory"),mount("/host/data/config.yaml","/same.yaml")]}),
        ];
        let copies = plan(&containers, "job").unwrap();
        assert_eq!(copies.len(), 1);
        let mapped = super::mount(
            &mount("/host/data/config.yaml", "/etc/config.yaml"),
            &copies,
        )
        .unwrap();
        assert_eq!(
            mapped["VolumeOptions"]["Subpath"],
            "__dockslate_transfer/config.yaml"
        );
        assert_eq!(mapped["ReadOnly"], true);
        assert_eq!(mapped["Target"], "/etc/config.yaml");
        assert!(!overlaps("/host/data", "/host/database"));
        assert!(super::mount(&mount("/other", "/etc/config"), &copies).is_err());
        assert!(!valid(&mount("/host", "/a/../escape")));
        assert!(super::mount(&mount("/host/data/../escape", "/etc/config"), &copies).is_err());
    }
    #[test]
    fn socket_reconnect_is_explicit_and_does_not_copy_socket_bytes() {
        let container = json!({"Mounts":[{"Type":"bind","Source":"/var/run/docker.sock","Destination":"/docker.sock","RW":false}]});
        let copies = plan(&[container.clone()], "job").unwrap();
        assert!(copies.is_empty());
        let mapped = mount(&container["Mounts"][0], &copies).unwrap();
        assert_eq!(mapped["Source"], "/var/run/docker.sock");
        assert_eq!(mapped["Type"], "bind");
        assert_eq!(mapped["ReadOnly"], true);
        assert!(!socket(
            &json!({"Type":"bind","Source":"/host/config/docker.sock"})
        ));
    }
    #[test]
    fn bind_helpers_are_stopped_read_only_and_quote_source_paths() {
        let image =
            json!({"Id":format!("sha256:{}","b".repeat(64)),"Config":{"Volumes":{"/data":{}}}});
        let args = bind_helper_args("/host/a,b\"c", &image, "job").unwrap();
        assert!(args.contains(
            &"type=bind,\"src=/host/a,b\"\"c\",dst=/__dockslate_transfer,readonly".to_owned()
        ));
        assert!(args.contains(&"type=tmpfs,dst=/data".to_owned()));
        assert!(!args
            .iter()
            .any(|v| v == "start" || v == "run" || v.starts_with("type=volume,")));
    }
    #[test]
    fn bind_archive_rejects_missing_roots_links_and_devices() {
        use std::io::Write;
        let token = runtime::new_token().unwrap();
        let mut workspace = Workspace::new(&token).unwrap();
        let (_, mut archive) = workspace.archive().unwrap();
        for kind in [b'0', b'5', b'2', b'3', b'6'] {
            archive.set_len(0).unwrap();
            archive.seek(SeekFrom::Start(0)).unwrap();
            let mut header = [0u8; 512];
            header[..SUBPATH.len()].copy_from_slice(SUBPATH.as_bytes());
            header[156] = kind;
            archive.write_all(&header).unwrap();
            assert_eq!(
                check_archive_root(&mut archive).is_ok(),
                [b'0', b'5'].contains(&kind)
            );
        }
        archive.set_len(512).unwrap();
        archive.seek(SeekFrom::Start(0)).unwrap();
        archive.write_all(&[0; 512]).unwrap();
        assert!(check_archive_root(&mut archive).is_err());
    }
}
