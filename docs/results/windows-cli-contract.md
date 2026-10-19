# Windows Docker CLI entry

`src-tauri/src/bin/docker.rs` builds a Windows console `docker.exe` launcher. It executes the real `/usr/bin/docker` and its Compose plugin inside DockSlate's owned WSL distribution. It is DockSlate's launcher, not Docker's official Windows binary, and does not expose a Windows named pipe.

## Connection and process contract

- Reads the same embedded `runtime-control.ps1` status operation used by the desktop app. Requires the exact owned DockSlate registration, valid ownership metadata, a running distribution, and the verified keepalive. It never installs, starts, stops, or reconfigures the engine.
- Pins ownership, keepalive, and mutation-lock files while the command runs. App runtime mutations must wait until the CLI command releases those handles. Rechecks runtime ownership after acquiring the handles.
- Reads Docker Engine version and identity through its fixed Unix socket before forwarding a command. Requires Linux Docker Engine and a nonempty engine ID; does not treat containerd as Docker Engine.
- Always targets `unix:///var/run/docker.sock` in `DockSlate`. Clears inherited Docker endpoint/TLS/API/config and Buildx endpoint selection variables. Uses Buildx's `default` builder.
- Rejects CLI host/context/config/TLS overrides before forwarding. Context management and custom Buildx builder management are unsupported. Container command arguments after the image/service/container boundary remain literal, including text such as `--host`.
- Passes final stdin/stdout/stderr directly to WSL and returns its exit code. Preparation failures use exit 125. Does not run `cmd /c`, build a shell command from user arguments, or consume caller stdin during verification.
- Root inside the owned guest has Docker daemon privileges, matching the existing application engine connection. Ordinary CLI commands can create or delete Docker objects when the user requests them; the desktop application's confirmation dialogs do not wrap direct CLI use.

## Windows paths

The current Windows folder must be on a local drive. The launcher converts it with fixed-argument `wslpath -a -u` and supplies the resulting guest directory through `wsl --cd`. Paths with spaces and Unicode are passed as arguments rather than inserted into shell text.

| Command/input | Converted host paths |
| --- | --- |
| `docker compose -f FILE --env-file FILE --project-directory DIR COMMAND` | Explicit global file and directory options **before** the Compose subcommand |
| `docker build`, `docker image build`, `docker buildx build` | Build context, `-f`/`--file`, `--metadata-file`, `--iidfile`, local output destinations, secret file sources, local cache sources/destinations, local named build contexts |
| `docker run` / `create`, including `docker container` aliases | `--env-file`, `--label-file`, `-v`/`--volume`, `--mount type=bind,source=...` |
| `docker compose run` | `--env-file`/`--env-from-file` and `-v`/`--volume` before the service name |
| `docker load` / `save`, including `docker image` aliases | `-i`/`--input`, `-o`/`--output` |
| `docker cp`, including `docker container cp` | Local source/destination; `container:/path` remains unchanged |

Drive-absolute `C:\project\file`, drive paths using `/`, and relative Windows paths are supported in these positions. Existing guest-absolute `/path` inputs remain guest paths. Named volumes such as `data:/data` remain names; `./data:/data` and `relative/data:/data` are converted bind sources. Environment assignments, build arguments, container paths, and container command payloads are not rewritten.

## Limits

- UNC/network paths, drive-relative `C:file`, control characters, and invalid-Unicode arguments fail explicitly. A single-letter container name in `docker cp c:/path ...` is ambiguous with a Windows drive and should be avoided.
- Use relative paths inside Compose YAML. The launcher does not rewrite YAML content, Dockerfile content, `.env` values, `COMPOSE_FILE`, or arbitrary plugin inputs containing Windows paths. Compose globals must precede the subcommand; `compose logs -f` remains the follow flag.
- Environment lookup occurs in the guest. Use explicit `-e KEY=value` and Compose env files for Windows values. This launcher does not copy all Windows environment variables or Windows registry credentials into WSL.
- Unknown options before a run/create/exec image, service, or container, and unknown build options fail rather than risk treating option values as command payloads. Use separate `-it -v ...`; mixed short clusters containing values are unsupported.
- Quoted CSV `--mount` and build fields are unsupported. For bind paths containing commas, use `-v`. Windows SSH agent socket/pipe integration is not provided; `--ssh` requires a guest-accessible value.
- CLI registry credentials belong to the guest's Docker configuration. This launcher does not install an official Windows credential helper or provide Windows third-party Docker SDK named-pipe compatibility.
- The CLI does not automatically start the engine when it is stopped. Complete Docker Engine setup/start in the app first. Installer PATH registration is a separate integration task.

## Build and verification

Build without downloads, dependency additions, lock changes, or executable launch:

```powershell
.\scripts\build-cli.ps1
```

This runs `cargo build --manifest-path src-tauri/Cargo.toml --bin docker --release --locked --offline` with the existing local Rust toolchain. Output: `src-tauri/target/release/docker.exe`. The script prints byte count and SHA-256 and does not run the file.

Read-only native checks prepared for explicitly authorized execution:

```powershell
& .\src-tauri\target\release\docker.exe version --format '{{json .Server}}'
& .\src-tauri\target\release\docker.exe compose version
& .\src-tauri\target\release\docker.exe ps --format '{{json .}}'
```

Actual Compose configuration/build/run, file/bind path translation, terminal input, and new-terminal PATH behavior require integration verification. A successful compilation alone does not establish those results. No existing MongoDB data should be changed to verify them.
