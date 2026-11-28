use super::{array, inspect_many, source_identity, strings, target_client, text, SOURCE};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

fn configured(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(values) => values.iter().any(configured),
        Value::Object(values) => values.values().any(configured),
        Value::Bool(true) => true,
    }
}
fn service_name(container: &Value) -> Result<String, String> {
    let value = text(container, "Name").trim_start_matches('/').to_ascii_lowercase();
    if value.is_empty() || value.len() > 63 || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte)) {
        return Err("컨테이너 이름은 영문·숫자·_.-의 63자 이내여야 합니다.".into());
    }
    Ok(value)
}
fn default_paths(key: &str, value: &Value) -> bool {
    let expected: &[&str] = if key == "MaskedPaths" {
        &["/proc/acpi", "/proc/asound", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/sched_debug", "/proc/scsi", "/proc/timer_list", "/proc/timer_stats", "/sys/devices/virtual/powercap", "/sys/firmware"]
    } else {
        &["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"]
    };
    let actual = strings(value);
    actual.len() == expected.len() && actual.iter().all(|path| expected.contains(&path.as_str()))
}
fn converted(containers: &[Value], source_networks: &[Value]) -> Result<Value, String> {
    if containers.is_empty() || containers.len() > 16 { return Err("설정을 가져올 컨테이너를 1~16개 선택하세요.".into()); }
    let names = containers.iter().map(service_name).collect::<Result<Vec<_>, _>>()?;
    if names.iter().collect::<HashSet<_>>().len() != names.len() { return Err("대소문자를 구분하지 않을 때 컨테이너 이름이 중복됩니다.".into()); }
    let mut services = Map::new();
    let mut volumes = Map::new();
    let mut networks = Map::new();
    let mut volume_names = HashMap::<String, String>::new();
    let mut network_names = HashMap::<String, String>::new();
    let mut blocked = Vec::new();
    for (source, name) in containers.iter().zip(&names) {
        let before = blocked.len();
        let config = &source["Config"];
        let host = &source["HostConfig"];
        if let Some(reason) = super::container_blocked(source) { blocked.push(format!("{name}: {reason}")); }
        if !config.is_object() || !host.is_object() { blocked.push(format!("{name}: 컨테이너 실행 설정이 없습니다.")); continue; }
        for (key, value) in host.as_object().unwrap() {
            let supported = match key.as_str() {
                "Binds" | "Mounts" | "PortBindings" | "RestartPolicy" | "ReadonlyRootfs" | "Init" | "NanoCpus" | "Memory" | "MemoryReservation" | "PidsLimit" | "LogConfig" | "NetworkMode" => true,
                "Runtime" => matches!(value.as_str(), Some("" | "runc")),
                "IpcMode" | "CgroupnsMode" => matches!(value.as_str(), Some("" | "private")),
                "ShmSize" => value.as_u64() == Some(67108864),
                "MaskedPaths" | "ReadonlyPaths" => default_paths(key, value),
                _ => false,
            };
            if !supported && configured(value) { blocked.push(format!("{name}: {key} 옵션은 Compose 설정 가져오기에서 지원하지 않습니다.")); }
        }
        if text(host, "NetworkMode") == "none" || config["NetworkDisabled"] == true { blocked.push(format!("{name}: 네트워크 비활성 설정은 지원하지 않습니다.")); }
        if configured(&config["MacAddress"]) { blocked.push(format!("{name}: 고정 MAC 주소 설정은 지원하지 않습니다.")); }
        let image = text(source, "Image");
        if !super::image_id(image) { blocked.push(format!("{name}: 원본 이미지 ID를 확인할 수 없습니다.")); }
        let mut service = json!({"image":image});
        for (from, to) in [("Cmd", "command"), ("Entrypoint", "entrypoint"), ("WorkingDir", "working_dir"), ("User", "user"), ("Hostname", "hostname"), ("Domainname", "domainname"), ("Tty", "tty"), ("OpenStdin", "stdin_open"), ("StopSignal", "stop_signal")] {
            if !config[from].is_null() { service[to] = config[from].clone(); }
        }
        if let Some(seconds) = config["StopTimeout"].as_u64() { service["stop_grace_period"] = json!(format!("{seconds}s")); }
        let mut environment = Map::new();
        for entry in strings(&config["Env"]) {
            if let Some((key, value)) = entry.split_once('=') { environment.insert(key.into(), json!(value)); }
            else { blocked.push(format!("{name}: 값이 없는 환경 변수는 자동 변환하지 않습니다.")); }
        }
        service["environment"] = json!(environment);
        service["labels"] = json!(config["Labels"].as_object().into_iter().flatten().filter(|(key, _)| !key.starts_with("com.docker.compose.") && !key.starts_with("io.dockslate.")).map(|(key, value)| (key.clone(), value.clone())).collect::<Map<_, _>>());
        if let Some(exposed) = config["ExposedPorts"].as_object() { service["expose"] = json!(exposed.keys().collect::<Vec<_>>()); }
        let health = &config["Healthcheck"];
        if health.is_object() {
            let mut check = json!({"test":health["Test"]});
            for (from, to) in [("Interval", "interval"), ("Timeout", "timeout"), ("StartPeriod", "start_period"), ("StartInterval", "start_interval")] {
                if let Some(nanos) = health[from].as_u64().filter(|value| *value != 0) { check[to] = json!(format!("{nanos}ns")); }
            }
            if let Some(retries) = health["Retries"].as_u64().filter(|value| *value != 0) { check["retries"] = json!(retries); }
            service["healthcheck"] = check;
        }
        for (from, to) in [("ReadonlyRootfs", "read_only"), ("Init", "init"), ("Memory", "mem_limit"), ("MemoryReservation", "mem_reservation"), ("PidsLimit", "pids_limit")] {
            if configured(&host[from]) { service[to] = host[from].clone(); }
        }
        if let Some(nanos) = host["NanoCpus"].as_u64().filter(|value| *value != 0) { service["cpus"] = json!(nanos as f64 / 1_000_000_000.0); }
        let restart = text(&host["RestartPolicy"], "Name");
        if !restart.is_empty() {
            let retries = host["RestartPolicy"]["MaximumRetryCount"].as_u64().unwrap_or(0);
            service["restart"] = json!(if restart == "on-failure" && retries > 0 { format!("on-failure:{retries}") } else { restart.into() });
        }
        if !text(&host["LogConfig"], "Type").is_empty() { service["logging"] = json!({"driver":host["LogConfig"]["Type"],"options":host["LogConfig"]["Config"]}); }
        let mut ports = Vec::new();
        for (target, bindings) in host["PortBindings"].as_object().into_iter().flatten() {
            let (target, protocol) = target.split_once('/').unwrap_or((target, "tcp"));
            let Some(target) = target.parse::<u16>().ok().filter(|port| *port != 0) else { blocked.push(format!("{name}: 포트 번호를 확인할 수 없습니다.")); continue; };
            for binding in array(bindings) {
                let mut port = json!({"target":target,"protocol":protocol});
                if !text(&binding, "HostPort").is_empty() { port["published"] = binding["HostPort"].clone(); }
                if !text(&binding, "HostIp").is_empty() { port["host_ip"] = binding["HostIp"].clone(); }
                ports.push(port);
            }
        }
        service["ports"] = json!(ports);
        let mut mounts = Vec::new();
        for mount in array(&source["Mounts"]) {
            if mount["Type"] != "volume" || text(&mount, "Name").is_empty() || !matches!(text(&mount, "Driver"), "" | "local") {
                blocked.push(format!("{name}: {} 연결({})은 지원하지 않습니다. 해당 컨테이너를 선택에서 제외하세요.", text(&mount, "Type"), text(&mount, "Destination"))); continue;
            }
            if array(&host["Mounts"]).iter().any(|value| value["Target"] == mount["Destination"] && configured(&value["VolumeOptions"]["Subpath"])) {
                blocked.push(format!("{name}: 볼륨 하위 경로 연결은 지원하지 않습니다.")); continue;
            }
            let next = format!("volume-{}", volume_names.len() + 1);
            let key = volume_names.entry(text(&mount, "Name").into()).or_insert(next).clone();
            volumes.insert(key.clone(), json!({}));
            mounts.push(json!({"type":"volume","source":key,"target":mount["Destination"],"read_only":mount["RW"]==false,"volume":{"nocopy":true}}));
        }
        service["volumes"] = json!(mounts);
        let mut endpoints = Map::new();
        for (original, endpoint) in source["NetworkSettings"]["Networks"].as_object().into_iter().flatten() {
            let Some(network) = source_networks.iter().find(|network| text(network, "Name") == original) else { blocked.push(format!("{name}: {original} 네트워크를 확인할 수 없습니다.")); continue; };
            let default_bridge = original == "bridge" && network["Options"].as_object().is_none_or(|options| options.iter().all(|(key, value)| match key.as_str() {
                "com.docker.network.bridge.default_bridge" | "com.docker.network.bridge.enable_icc" | "com.docker.network.bridge.enable_ip_masquerade" => value == "true",
                "com.docker.network.bridge.host_binding_ipv4" => value == "0.0.0.0",
                "com.docker.network.bridge.name" => value == "docker0",
                "com.docker.network.driver.mtu" => value == "1500" || value == "0",
                _ => false,
            }));
            if network["Driver"] != "bridge" || (!default_bridge && configured(&network["Options"])) || !matches!(text(&network["IPAM"], "Driver"), "" | "default") || configured(&network["IPAM"]["Options"]) || configured(&network["ConfigFrom"]) || network["ConfigOnly"] == true || configured(&endpoint["GwPriority"]) {
                blocked.push(format!("{name}: {original} 네트워크의 드라이버·사용자 옵션은 지원하지 않습니다.")); continue;
            }
            let next = format!("network-{}", network_names.len() + 1);
            let key = network_names.entry(original.clone()).or_insert(next).clone();
            let mut resource = json!({"driver":"bridge"});
            for (from, to) in [("Internal", "internal"), ("Attachable", "attachable"), ("EnableIPv6", "enable_ipv6"), ("EnableIPv4", "enable_ipv4")] { if !network[from].is_null() { resource[to] = network[from].clone(); } }
            networks.insert(key.clone(), resource);
            let mut aliases = strings(&endpoint["Aliases"]);
            aliases.retain(|alias| !text(source, "Id").starts_with(alias.as_str()));
            aliases.push(text(source, "Name").trim_start_matches('/').into());
            aliases.sort(); aliases.dedup();
            endpoints.insert(key, json!({"aliases":aliases}));
        }
        if endpoints.is_empty() { blocked.push(format!("{name}: 연결할 bridge 네트워크가 없습니다.")); }
        service["networks"] = json!(endpoints);
        let labels = &config["Labels"];
        let mut dependencies = Map::new();
        for dependency in text(labels, "com.docker.compose.depends_on").split(',').filter(|value| !value.is_empty()) {
            let mut parts = dependency.split(':');
            let original = parts.next().unwrap();
            let matches = containers.iter().enumerate().filter(|(_, candidate)| candidate["Config"]["Labels"]["com.docker.compose.project"] == labels["com.docker.compose.project"] && text(&candidate["Config"]["Labels"], "com.docker.compose.service") == original).collect::<Vec<_>>();
            if matches.len() != 1 { blocked.push(format!("{name}: 의존 서비스 {original}의 컨테이너를 정확히 하나 함께 선택하세요.")); continue; }
            let condition = parts.next().unwrap_or("service_started");
            if !["service_started", "service_healthy", "service_completed_successfully"].contains(&condition) { blocked.push(format!("{name}: 의존 서비스 {original}의 실행 조건은 지원하지 않습니다.")); continue; }
            dependencies.insert(names[matches[0].0].clone(), json!({"condition":condition,"restart":parts.next()==Some("true")}));
        }
        if !dependencies.is_empty() { service["depends_on"] = json!(dependencies); }
        if blocked.len() == before { services.insert(name.clone(), service); }
    }
    if !blocked.is_empty() { return Err(blocked.join("\n")); }
    Ok(json!({"services":services,"volumes":volumes,"networks":networks}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn container() -> Value {
        json!({"Id":"a".repeat(64),"Name":"/demo-web-1","Image":format!("sha256:{}", "b".repeat(64)),"State":{"Status":"running"},
            "Config":{"Image":"demo/web:latest","Cmd":["sh","-c","printf '$PASSWORD\\!'"],"Entrypoint":["/entrypoint"],"Env":["PASSWORD=p${secret}$$\\!","DB_URL=postgres://db/app"],"User":"1000","WorkingDir":"/app","StopTimeout":30,"Healthcheck":{"Test":["CMD-SHELL","test -n \"$PASSWORD\""],"Interval":1000000000,"Retries":3},"Labels":{"com.docker.compose.project":"demo","com.docker.compose.service":"web","owner":"team"}},
            "HostConfig":{"NetworkMode":"demo_default","PortBindings":{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"18080"}]},"RestartPolicy":{"Name":"on-failure","MaximumRetryCount":4},"ReadonlyRootfs":true,"Init":true,"ShmSize":67108864},
            "Mounts":[{"Type":"volume","Name":"data","Driver":"local","Destination":"/data","RW":false}],"NetworkSettings":{"Networks":{"demo_default":{"Aliases":["web","demo-web-1"]}}}})
    }
    fn networks() -> Vec<Value> { vec![json!({"Name":"demo_default","Driver":"bridge","Internal":true,"Options":{},"IPAM":{"Driver":"default"}})] }

    #[test]
    fn configuration_preserves_literals_settings_and_shared_empty_volumes() {
        let source = container();
        let mut other = source.clone();
        other["Name"] = json!("/demo-worker-1"); other["Id"] = json!("c".repeat(64));
        let config = converted(&[source.clone(), other], &networks()).unwrap();
        let service = &config["services"]["demo-web-1"];
        assert_eq!(service["image"], source["Image"]);
        assert_eq!(service["command"], source["Config"]["Cmd"]);
        assert_eq!(service["environment"]["PASSWORD"], "p${secret}$$\\!");
        assert_eq!(service["restart"], "on-failure:4");
        assert_eq!(service["ports"][0], json!({"target":8080,"protocol":"tcp","host_ip":"127.0.0.1","published":"18080"}));
        assert_eq!(service["volumes"][0]["volume"]["nocopy"], true);
        assert_eq!(service["volumes"][0]["read_only"], true);
        assert_eq!(config["volumes"].as_object().unwrap().len(), 1);
        assert_eq!(config["networks"]["network-1"]["internal"], true);
        assert_eq!(service["healthcheck"]["interval"], "1000000000ns");
        assert_eq!(service["labels"], json!({"owner":"team"}));
        assert_eq!(service["user"], "1000"); assert_eq!(service["working_dir"], "/app");
        let mut standalone = container(); standalone["NetworkSettings"]["Networks"] = json!({"bridge":{}});
        let bridge = json!({"Name":"bridge","Driver":"bridge","Options":{"com.docker.network.bridge.default_bridge":"true","com.docker.network.bridge.name":"docker0","com.docker.network.driver.mtu":"1500"}});
        assert!(converted(&[standalone], &[bridge]).is_ok());
    }
    #[test]
    #[ignore = "requires DOCKSLATE_TEST_COMPOSE pointing to a hash-verified Compose executable"]
    fn configuration_matches_offline_compose_interpolation_and_schema() {
        let tool = std::env::var_os("DOCKSLATE_TEST_COMPOSE").expect("Verify the Compose executable hash before running this check");
        let profile = std::env::var_os("DOCKER_CONFIG").expect("Set DOCKER_CONFIG to a fresh workspace fixture directory");
        let profile = std::fs::canonicalize(profile).unwrap();
        let fixtures = std::fs::canonicalize(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".analysis")).unwrap();
        assert!(profile.starts_with(fixtures) && std::fs::read_dir(profile).unwrap().next().is_none(), "An empty isolated Docker config is required");
        let source = container();
        let render = |config: &Value, interpolate: bool| -> Value {
            let mut arguments = ["--env-file", "NUL", "--project-name", "dockslate-configuration-check", "--file", "-", "config", "--format", "json", "--no-env-resolution"].map(str::to_owned).to_vec();
            if !interpolate { arguments.push("--no-interpolate".into()); }
            let bytes = serde_json::to_vec(config).unwrap();
            let output = crate::process::execute(std::path::Path::new(&tool), &arguments, Some(&bytes), std::time::Duration::from_secs(30), 2 * 1024 * 1024).unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let exported = String::from_utf8(output.stdout).unwrap();
            serde_json::from_str(&if interpolate { exported.replace("$$", "$") } else { exported }).unwrap()
        };
        let mut config = render(&converted(&[source.clone()], &networks()).unwrap(), false);
        assert_eq!(config["services"]["demo-web-1"]["environment"]["PASSWORD"], "p${secret}$$\\!");
        crate::compose::literal_values(&mut config);
        let normalized = render(&config, true);
        let service = &normalized["services"]["demo-web-1"];
        assert_eq!(service["environment"]["PASSWORD"], "p${secret}$$\\!");
        assert_eq!(service["command"], source["Config"]["Cmd"]);
        assert_eq!(service["healthcheck"]["test"], source["Config"]["Healthcheck"]["Test"]);
        assert_eq!(service["ports"][0]["published"], "18080");
        assert_eq!(normalized["volumes"].as_object().unwrap().len(), 1);
    }
    #[test]
    fn configuration_blocks_unsupported_items_missing_dependencies_and_limits() {
        assert!(converted(&[], &[]).is_err());
        assert!(converted(&vec![container();17], &networks()).is_err());
        for (key, value) in [("Privileged", json!(true)), ("SecurityOpt", json!(["no-new-privileges"])), ("Dns", json!(["192.0.2.1"])), ("FutureOption", json!(true))] {
            let mut source = container(); source["HostConfig"][key] = value;
            let error = converted(&[source], &networks()).unwrap_err();
            assert!(error.contains(key)); assert!(!error.contains("p${secret}"));
        }
        for kind in ["bind", "tmpfs"] {
            let mut source = container(); source["Mounts"][0]["Type"] = json!(kind);
            assert!(converted(&[source], &networks()).unwrap_err().contains(kind));
        }
        let mut source = container(); source["Config"]["Labels"]["com.docker.compose.depends_on"] = json!("db:service_healthy:false");
        assert!(converted(&[source.clone()], &networks()).unwrap_err().contains("db"));
        let mut database = container(); database["Name"] = json!("/demo-db-1"); database["Config"]["Labels"]["com.docker.compose.service"] = json!("db");
        assert_eq!(converted(&[source, database], &networks()).unwrap()["services"]["demo-web-1"]["depends_on"]["demo-db-1"]["condition"], "service_healthy");
        let mut network = networks(); network[0]["Options"] = json!({"mtu":"9000"});
        assert!(converted(&[container()], &network).unwrap_err().contains("네트워크"));
    }
}
pub(super) fn prepare(ids: Vec<String>) -> Result<Value, String> {
    if super::is_busy() || crate::compose::is_busy() { return Err("진행 중인 가져오기를 마친 뒤 설정을 검사하세요.".into()); }
    if ids.is_empty() || ids.len() > 16 || ids.iter().any(|id| !super::id(id)) || ids.iter().collect::<HashSet<_>>().len() != ids.len() { return Err("설정을 가져올 컨테이너 ID를 1~16개 선택하세요.".into()); }
    let target = target_client()?;
    let source = source_identity()?;
    if source == target.identity { return Err("원본과 대상 엔진이 같습니다.".into()); }
    let containers = inspect_many(SOURCE, "container", &ids)?;
    if containers.iter().zip(&ids).any(|(container, id)| text(container, "Id") != id) { return Err("선택한 원본 컨테이너가 변경되었습니다. 목록을 다시 조회하세요.".into()); }
    let network_names = containers.iter().flat_map(|container| container["NetworkSettings"]["Networks"].as_object().into_iter().flatten().map(|(name, _)| name.clone())).collect::<HashSet<_>>().into_iter().collect::<Vec<_>>();
    let networks = inspect_many(SOURCE, "network", &network_names)?;
    let config = converted(&containers, &networks)?;
    if source_identity()? != source { return Err("Docker Desktop 엔진이 변경되었습니다. 설정을 다시 검사하세요.".into()); }
    let images = containers.iter().map(|container| format!("{}: {}", text(container, "Name").trim_start_matches('/'), text(&container["Config"], "Image"))).collect::<Vec<_>>().join(", ");
    crate::compose::prepare_configuration(&target, config, vec![
        "컨테이너 실행 설정만 가져옵니다. 원본은 중지·수정·삭제하지 않으며 이미지·쓰기 계층·볼륨·연결 파일의 데이터는 복사하지 않습니다.".into(),
        "표시된 새 볼륨은 빈 상태로 생성됩니다. 데이터가 필요한 서비스는 별도로 데이터를 복원하기 전까지 정상 동작하지 않을 수 있습니다.".into(),
        "새 Compose 프로젝트의 컨테이너·bridge 네트워크를 생성합니다. 컨테이너 이름과 네트워크 주소는 새로 할당되며 공개 포트가 원본과 충돌할 수 있습니다.".into(),
        format!("원본과 동일한 이미지 ID가 DockSlate에 있어야 합니다. 이미지는 자동 다운로드하지 않습니다. 필요한 이미지: {images}"),
    ])
}
