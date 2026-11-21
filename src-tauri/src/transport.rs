use crate::runtime::{ReadGuard, inspect, inspect_status, is_mutating, poll_operation, system_directory};
use serde_json::Value;
use std::{io::Write, process::{Child, Command, Stdio}, sync::Arc, time::Duration};

#[derive(Clone)]
pub struct Transport {
    pub owner: String,
    pub context: String,
    fingerprint: Value,
    guard: Arc<ReadGuard>,
}
impl Transport {
    fn verify(&self, mutation: bool) -> Result<(), String> {
        if is_mutating() || crate::wsl::is_compacting() {
            return Err("A runtime or disk operation is running; Docker access is blocked.".into());
        }
        self.guard.validate(&self.owner, &self.fingerprint)?;
        if mutation {
            let current = inspect("status")?;
            if current["state"] != "running"
                || current["keeperVerified"] != true
                || !current.get("fingerprint").is_some_and(|value| crate::runtime::same_ownership_fingerprint(&self.fingerprint, value))
            {
                return Err(
                    "The owned runtime stopped or its ownership changed. Refresh the connection."
                        .into(),
                );
            }
        }
        Ok(())
    }

    pub(crate) fn build_path(&self, windows_path: &str) -> Result<String, String> {
        self.verify(false)?;
        let output = crate::process::execute(
            &system_directory()?.join("wsl.exe"),
            &[
                "--distribution".into(),
                "DockSlate".into(),
                "--user".into(),
                "root".into(),
                "--exec".into(),
                "/usr/bin/wslpath".into(),
                "-a".into(),
                "-u".into(),
                windows_path.into(),
            ],
            None,
            Duration::from_secs(15),
            65536,
        )?;
        if !output.status.success() {
            return Err("빌드 폴더를 DockSlate WSL 경로로 변환하지 못했습니다.".into());
        }
        let path = String::from_utf8(output.stdout)
            .map_err(|_| "WSL 경로 인코딩을 확인할 수 없습니다.")?;
        let path = path.trim_end_matches(['\r', '\n']);
        if !path.starts_with('/') || path.chars().any(char::is_control) || path.len() > 65535 {
            return Err("WSL 빌드 경로를 확인할 수 없습니다.".into());
        }
        Ok(path.into())
    }

    pub(crate) fn spawn_configured_image_build(
        &self,
        context: &str,
        dockerfile: &str,
        tag: &str,
        no_cache: bool,
        builder: &str,
    ) -> Result<Child, String> {
        if builder.is_empty()
            || builder.len() > 128
            || !builder
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        {
            return Err("Invalid internal Buildx builder name.".into());
        }
        self.verify(true)?;
        let mut command = Command::new(system_directory()?.join("wsl.exe"));
        command.args([
            "--distribution",
            "DockSlate",
            "--user",
            "root",
            "--exec",
            "/usr/bin/docker",
            "--host",
            "unix:///var/run/docker.sock",
            "buildx",
            "build",
            "--builder",
            builder,
            "--load",
            "--progress=plain",
            "--file",
            dockerfile,
            "--tag",
            tag,
        ]);
        if no_cache {
            command.arg("--no-cache");
        }
        command.arg("--").arg(context);
        for name in [
            "DOCKER_HOST",
            "DOCKER_CONTEXT",
            "DOCKER_CONFIG",
            "BUILDX_BUILDER",
            "BUILDX_CONFIG",
        ] {
            command.env_remove(name);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
            .spawn()
            .map_err(|error| format!("DockSlate 이미지 빌드를 시작할 수 없습니다: {error}"))
    }

    pub fn discover() -> Result<Self, String> {
        #[cfg(windows)]
        if !is_mutating() && !crate::wsl::is_compacting() {
            if let Ok((owner, fingerprint, lease)) = ReadGuard::discover() {
                let _ = poll_operation()?;
                return Ok(Self { owner, context: "dockslate".into(), fingerprint, guard: Arc::new(lease) });
            }
        }
        Self::from_status(&inspect_status()?)
    }
    pub fn from_status(current: &Value) -> Result<Self, String> {
        let _ = poll_operation()?;
        if is_mutating() || crate::wsl::is_compacting() {
            return Err("A runtime or disk operation is running; Docker access is blocked.".into());
        }
        if matches!(
            current["state"].as_str(),
            Some("installing" | "starting" | "stopping")
        ) {
            return Err("A runtime or disk operation is running; Docker access is blocked.".into());
        }
        if current["state"] != "running" || current["keeperVerified"] != true {
            return Err(current["message"]
                .as_str()
                .unwrap_or("The owned DockSlate runtime is unavailable.")
                .into());
        }
        let owner: String = current["installPath"]
            .as_str()
            .ok_or("The owned runtime path is unavailable.")?
            .into();
        let fingerprint = current
            .get("fingerprint")
            .cloned()
            .filter(|value| !value.is_null())
            .ok_or("The runtime ownership fingerprint is unavailable.")?;
        let guard = Arc::new(ReadGuard::acquire(&owner, &fingerprint)?);
        Ok(Self {
            owner,
            context: "dockslate".into(),
            fingerprint,
            guard,
        })
    }
    pub fn request(
        &self,
        method: &str,
        path: &str,
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        self.request_inner(method, path, None, timeout, limit, None)
    }

    pub(crate) fn request_observed(
        &self,
        method: &str,
        path: &str,
        timeout: Duration,
        limit: usize,
        observer: Box<dyn FnMut(&[u8]) + Send>,
    ) -> Result<Vec<u8>, String> {
        self.request_inner(method, path, None, timeout, limit, Some(observer))
    }

    pub(crate) fn archive_stat(&self, api: &str, id: &str, path: &str) -> Result<Vec<u8>, String> {
        let valid_api = api
            .strip_prefix("1.")
            .and_then(|minor| minor.parse::<u32>().ok())
            .is_some_and(|minor| (41..=55).contains(&minor));
        if !valid_api
            || id.len() != 64
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || !path.starts_with('/')
            || path.len() > 4096
            || path.contains('\0')
            || path.split('/').any(|part| matches!(part, "." | ".."))
            || path.split('/').filter(|part| !part.is_empty()).count() > 32
        {
            return Err("Invalid internal container archive metadata request.".into());
        }
        self.verify(false)?;
        let encoded: String = path
            .bytes()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                    (byte as char).to_string()
                } else {
                    format!("%{byte:02X}")
                }
            })
            .collect();
        let args = [
            "--distribution".into(),
            "DockSlate".into(),
            "--user".into(),
            "root".into(),
            "--exec".into(),
            "/usr/bin/curl".into(),
            "--disable".into(),
            "--silent".into(),
            "--show-error".into(),
            "--noproxy".into(),
            "*".into(),
            "--unix-socket".into(),
            "/var/run/docker.sock".into(),
            "--proto".into(),
            "=http".into(),
            "--head".into(),
            "--max-time".into(),
            "5".into(),
            "--write-out".into(),
            "\n%{http_code}".into(),
            "--".into(),
            format!("http://localhost/v{api}/containers/{id}/archive?path={encoded}"),
        ];
        let output = crate::process::execute(
            &system_directory()?.join("wsl.exe"),
            &args,
            None,
            Duration::from_secs(7),
            8192,
        )?;
        if !output.status.success() {
            return Err("컨테이너 경로 정보를 읽지 못했거나 응답 시간이 초과되었습니다.".into());
        }
        let text = std::str::from_utf8(&output.stdout)
            .map_err(|_| "컨테이너 경로 응답 형식이 올바르지 않습니다.")?;
        let (headers, status) = text
            .rsplit_once('\n')
            .ok_or("컨테이너 경로 응답 상태를 확인하지 못했습니다.")?;
        let code = status
            .parse::<u16>()
            .map_err(|_| "컨테이너 경로 응답 상태를 확인하지 못했습니다.")?;
        if !(200..300).contains(&code) {
            return Err(format!(
                "컨테이너 경로를 확인하지 못했습니다 (Docker HTTP {code})."
            ));
        }
        let mut values = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .filter(|(key, _)| key.eq_ignore_ascii_case("X-Docker-Container-Path-Stat"))
            .map(|(_, value)| value.trim());
        let metadata = values
            .next()
            .filter(|value| !value.is_empty())
            .ok_or("컨테이너 경로 정보 헤더가 없습니다.")?;
        if values.next().is_some() {
            return Err("컨테이너 경로 정보 헤더가 중복되었습니다.".into());
        }
        Ok(metadata.as_bytes().to_vec())
    }

    pub(crate) fn create_container(
        &self,
        api: &str,
        name: &str,
        body: &[u8],
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        self.create_json(api, "containers", name, body, timeout, limit)
    }

    pub(crate) fn create_network(
        &self,
        api: &str,
        body: &[u8],
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        self.create_json(api, "networks", "", body, timeout, limit)
    }

    pub(crate) fn create_volume(
        &self,
        api: &str,
        body: &[u8],
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        self.create_json(api, "volumes", "", body, timeout, limit)
    }

    pub(crate) fn verify_tool_session(&self) -> Result<(), String> {
        self.verify(false)
    }
    pub(crate) fn verify_tool_start(&self) -> Result<(), String> {
        self.verify(true)
    }

    pub(crate) fn spawn_dial_stdio(&self) -> Result<Child, String> {
        self.verify_tool_start()?;
        // Guest session identity and bounded process lifetime.
        const RELAY: &str = r#"read -r stat < /proc/$$/stat || exit 125
stat="${stat##*) }"
set -- $stat
printf 'DOCKSLATE_PROXY_SESSION:%s:%s\n' "$$" "${20}" >&2
exec /usr/bin/timeout --foreground --signal=TERM --kill-after=5s 86400s /usr/bin/env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u DOCKER_API_VERSION -u DOCKER_CUSTOM_HEADERS -u BUILDX_BUILDER -u BUILDX_CONFIG /usr/bin/docker --config /run/dockslate/proxy-cli --host unix:///var/run/docker.sock system dial-stdio"#;
        let mut command = Command::new(system_directory()?.join("wsl.exe"));
        command.args([
            "--distribution",
            "DockSlate",
            "--user",
            "root",
            "--exec",
            "/usr/bin/setsid",
            "--wait",
            "/bin/sh",
            "-c",
            RELAY,
        ]);
        for key in [
            "DOCKER_HOST",
            "DOCKER_CONTEXT",
            "DOCKER_CONFIG",
            "DOCKER_TLS",
            "DOCKER_TLS_VERIFY",
            "DOCKER_CERT_PATH",
            "DOCKER_API_VERSION",
            "DOCKER_CUSTOM_HEADERS",
            "BUILDX_BUILDER",
            "BUILDX_CONFIG",
        ] {
            command.env_remove(key);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
            .spawn()
            .map_err(|e| format!("Cannot connect the owned Docker socket: {e}"))
    }

    pub(crate) fn cancel_dial_stdio(&self, pid: u32, started: u64) -> Result<(), String> {
        if pid <= 1 || started == 0 {
            return Err("Invalid Docker proxy guest session".into());
        }
        self.verify_tool_session()?;
        // PID reuse check before each process-group signal.
        const STOP: &str = r#"pid=$1; expected=$2
check() {
  read -r stat < "/proc/$pid/stat" 2>/dev/null || return 1
  stat="${stat##*) }"; set -- $stat
  [ "${20}" = "$expected" ]
}
check || exit 0
/usr/bin/kill -TERM -- "-$pid" 2>/dev/null || exit 0
/usr/bin/sleep 0.2
check || exit 0
/usr/bin/kill -KILL -- "-$pid" 2>/dev/null || true"#;
        let output = crate::process::execute(
            &system_directory()?.join("wsl.exe"),
            &[
                "--distribution".into(),
                "DockSlate".into(),
                "--user".into(),
                "root".into(),
                "--exec".into(),
                "/bin/sh".into(),
                "-c".into(),
                STOP.into(),
                "dockslate-proxy-stop".into(),
                pid.to_string(),
                started.to_string(),
            ],
            None,
            Duration::from_secs(3),
            4096,
        )?;
        if !output.status.success() {
            return Err("The Docker proxy guest session could not be stopped".into());
        }
        Ok(())
    }

    pub(crate) fn buildx_command(
        &self,
        arguments: &[String],
        mutation: bool,
        input: Option<&[u8]>,
        timeout: Duration,
        limit: usize,
    ) -> Result<std::process::Output, String> {
        if arguments.is_empty() || arguments.iter().any(|arg| arg.contains('\0')) {
            return Err("Invalid internal Buildx request.".into());
        }
        self.verify(mutation)?;
        let mut args: Vec<String> = [
            "--distribution",
            "DockSlate",
            "--user",
            "root",
            "--exec",
            "/usr/bin/env",
            "-u",
            "DOCKER_HOST",
            "-u",
            "DOCKER_CONTEXT",
            "-u",
            "DOCKER_CONFIG",
            "-u",
            "BUILDX_BUILDER",
            "-u",
            "BUILDX_CONFIG",
            "/usr/bin/docker",
            "--host",
            "unix:///var/run/docker.sock",
            "buildx",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        args.extend_from_slice(arguments);
        crate::process::execute(
            &system_directory()?.join("wsl.exe"),
            &args,
            input,
            timeout,
            limit,
        )
    }

    pub(crate) fn spawn_volume_files(
        &self,
        request: &Value,
        mutation: bool,
    ) -> Result<Child, String> {
        self.verify(mutation)?;
        let serialized =
            serde_json::to_string(request).map_err(|_| "Invalid internal volume request.")?;
        if serialized.len() > 16384 {
            return Err("Volume request is too large.".into());
        }
        let mut command = Command::new(system_directory()?.join("wsl.exe"));
        command.args([
            "--distribution",
            "DockSlate",
            "--user",
            "root",
            "--exec",
            "/usr/bin/timeout",
            "--signal=TERM",
            "--kill-after=5s",
            "910s",
            "/usr/bin/python3",
            "-I",
            "-",
            &serialized,
        ]);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| {
            "볼륨 파일 작업을 시작할 수 없습니다. DockSlate 엔진과 Python 3을 확인하세요."
        })?;
        let mut input = child
            .stdin
            .take()
            .ok_or("Volume helper input is unavailable.")?;
        if input
            .write_all(include_bytes!("../scripts/volume-files.py"))
            .is_err()
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "볼륨 파일 도구를 시작하지 못했습니다. 전용 WSL의 Python 3 지원을 확인하세요."
                    .into(),
            );
        }
        drop(input);
        Ok(child)
    }

    fn create_json(
        &self,
        api: &str,
        resource: &str,
        name: &str,
        body: &[u8],
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        let valid_api = api
            .strip_prefix("1.")
            .and_then(|minor| minor.parse::<u32>().ok())
            .is_some_and(|minor| (41..=55).contains(&minor));
        let valid_name = name.is_empty()
            || (name.len() <= 128
                && name.as_bytes()[0].is_ascii_alphanumeric()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte)));
        if !valid_api
            || !valid_name
            || !["containers", "networks", "volumes"].contains(&resource)
            || (resource != "containers" && !name.is_empty())
            || body.is_empty()
            || body.len() > 64 * 1024
        {
            return Err("Invalid internal Docker create request.".into());
        }
        let query = if name.is_empty() {
            String::new()
        } else {
            format!("?name={name}")
        };
        self.request_inner(
            "POST",
            &format!("/v{api}/{resource}/create{query}"),
            Some(body),
            timeout,
            limit,
            None,
        )
    }

    fn request_inner(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        timeout: Duration,
        limit: usize,
        observer: Option<Box<dyn FnMut(&[u8]) + Send>>,
    ) -> Result<Vec<u8>, String> {
        if !["GET", "POST", "DELETE"].contains(&method)
            || !path.starts_with('/')
            || path.len() > 4096
            || path
                .bytes()
                .any(|byte| byte <= 32 || byte >= 127 || matches!(byte, b'#' | b'\\'))
            || timeout.is_zero()
            || limit == 0
            || limit > 32 * 1024 * 1024
        {
            return Err("Invalid internal Docker request.".into());
        }
        self.verify(method != "GET")?;
        let program = system_directory()?.join("wsl.exe");
        let seconds = timeout.as_secs_f64().max(0.1).to_string();
        let mut args = vec![
            "--distribution".into(),
            "DockSlate".into(),
            "--user".into(),
            "root".into(),
            "--exec".into(),
            "/usr/bin/curl".into(),
            "--disable".into(),
            "--silent".into(),
            "--show-error".into(),
            "--noproxy".into(),
            "*".into(),
            "--unix-socket".into(),
            "/var/run/docker.sock".into(),
            "--proto".into(),
            "=http".into(),
            "--request".into(),
            method.into(),
            "--max-time".into(),
            seconds,
            "--max-filesize".into(),
            limit.to_string(),
            "--write-out".into(),
            "\n%{http_code}".into(),
        ];
        if observer.is_some() {
            args.push("--no-buffer".into());
        }
        if body.is_some() {
            args.extend([
                "--header".into(),
                "Content-Type: application/json".into(),
                "--data-binary".into(),
                "@-".into(),
            ]);
        }
        args.extend(["--".into(), format!("http://localhost{path}")]);
        let output = crate::process::execute_observed(
            &program,
            &args,
            body,
            timeout + Duration::from_secs(2),
            limit.saturating_add(4096),
            observer,
        )?;
        if !output.status.success() {
            return Err("The owned Docker socket request failed or timed out; a mutation outcome may be unknown. Refresh before retrying.".into());
        }
        let split = output
            .stdout
            .len()
            .checked_sub(4)
            .ok_or("The Docker response has no HTTP status.")?;
        if output.stdout[split] != b'\n' {
            return Err("The Docker response has an invalid HTTP status.".into());
        }
        let code = std::str::from_utf8(&output.stdout[split + 1..])
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .ok_or("The Docker response has an invalid HTTP status.")?;
        let body = &output.stdout[..split];
        if body.len() > limit {
            return Err("The Docker response exceeds its safety limit.".into());
        }
        if !(200..300).contains(&code) {
            let message = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|value| value["message"].as_str().map(str::to_owned))
                .unwrap_or_else(|| format!("Docker HTTP {code}"));
            return Err(format!(
                "Docker HTTP {code}: {}",
                message.chars().take(1000).collect::<String>()
            ));
        }
        Ok(body.to_vec())
    }
}
