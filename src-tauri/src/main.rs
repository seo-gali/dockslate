#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod builds;
mod compose;
mod container_tools;
mod desktop;
mod docker;
mod image_build;
mod image_pull;
mod image_removal;
mod live_logs;
mod process;
mod resources;
mod runtime;
mod volumes;
mod wsl;

use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::Emitter;

static MUTATION: Mutex<()> = Mutex::new(());
static EXIT_PENDING: AtomicBool = AtomicBool::new(false);

async fn read<F>(operation: F) -> Result<Value, String>
where
    F: FnOnce() -> Result<Value, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| error.to_string())?
}

async fn mutate<F>(operation: F) -> Result<Value, String>
where
    F: FnOnce() -> Result<Value, String> + Send + 'static,
{
    read(move || {
        let _guard = MUTATION
            .try_lock()
            .map_err(|_| "다른 작업이 진행 중입니다".to_string())?;
        if EXIT_PENDING.load(Ordering::Acquire) {
            return Err("DockSlate가 종료 중입니다.".into());
        }
        if wsl::is_compacting() {
            return Err("VHDX 압축이 진행 중입니다".into());
        }
        if runtime::is_mutating() {
            return Err("엔진 설치 또는 상태 변경이 진행 중입니다".into());
        }
        if volumes::is_busy() || builds::is_busy() || compose::is_busy() {
            return Err("파일 전송 작업이 진행 중입니다. 완료 후 다시 시도하세요.".into());
        }
        if image_build::is_building() {
            return Err("이미지 빌드가 진행 중입니다. 완료 후 다시 시도하세요.".into());
        }
        operation()
    })
    .await
}

#[tauri::command]
async fn container_files(id: String, path: String) -> Result<Value, String> {
    read(move || container_tools::files(id, path)).await
}
#[tauri::command]
async fn container_file_preview(id: String, path: String) -> Result<Value, String> {
    read(move || container_tools::file_preview(id, path)).await
}
#[tauri::command]
async fn terminal_open(id: String, shell: String, cols: u16, rows: u16) -> Result<Value, String> {
    read(move || container_tools::terminal_open(id, shell, cols, rows)).await
}
#[tauri::command]
async fn terminal_read(session_id: String, cursor: u64) -> Result<Value, String> {
    read(move || container_tools::terminal_read(session_id, cursor)).await
}
#[tauri::command]
async fn terminal_input(session_id: String, data: String) -> Result<Value, String> {
    read(move || container_tools::terminal_input(session_id, data)).await
}
#[tauri::command]
async fn terminal_resize(session_id: String, cols: u16, rows: u16) -> Result<Value, String> {
    read(move || container_tools::terminal_resize(session_id, cols, rows)).await
}
#[tauri::command]
async fn terminal_close(session_id: String) -> Result<Value, String> {
    read(move || container_tools::terminal_close(session_id)).await
}

#[tauri::command]
async fn volumes_list() -> Result<Value, String> {
    read(volumes::list).await
}
#[tauri::command]
async fn volume_inspect(name: String) -> Result<Value, String> {
    read(move || volumes::inspect(name)).await
}
#[tauri::command]
async fn volume_create(name: String) -> Result<Value, String> {
    mutate(move || volumes::create(name)).await
}
#[tauri::command]
async fn volume_clone(name: String, destination: String) -> Result<Value, String> {
    mutate(move || volumes::clone_volume(name, destination)).await
}
#[tauri::command]
async fn volume_browse(name: String, path: String) -> Result<Value, String> {
    read(move || volumes::browse(name, path)).await
}
#[tauri::command]
async fn volume_file_preview(name: String, path: String) -> Result<Value, String> {
    read(move || volumes::file_preview(name, path)).await
}
#[tauri::command]
async fn volume_pick_archive(purpose: String) -> Result<Value, String> {
    read(move || volumes::pick_archive(purpose)).await
}
#[tauri::command]
async fn volume_export(name: String, archive_token: String) -> Result<Value, String> {
    mutate(move || volumes::export(name, archive_token)).await
}
#[tauri::command]
async fn volume_import_preview(
    name: String,
    archive_token: String,
    mode: String,
) -> Result<Value, String> {
    read(move || volumes::import_preview(name, archive_token, mode)).await
}
#[tauri::command]
async fn volume_destructive_preview(kind: String, name: String) -> Result<Value, String> {
    read(move || volumes::destructive_preview(kind, name)).await
}
#[tauri::command]
async fn volume_execute(token: String, approved: bool) -> Result<Value, String> {
    mutate(move || volumes::execute(token, approved)).await
}
#[tauri::command]
async fn volume_discard_preview(token: String) -> Result<Value, String> {
    read(move || volumes::discard_preview(token)).await
}
#[tauri::command]
async fn volume_job_status(id: String) -> Result<Value, String> {
    read(move || volumes::job_status(id)).await
}
#[tauri::command]
async fn builds_snapshot() -> Result<Value, String> {
    read(builds::snapshot).await
}
#[tauri::command]
async fn builds_builder_inspect(name: String) -> Result<Value, String> {
    read(move || builds::builder_inspect(name)).await
}
#[tauri::command]
async fn builds_history_list(builder: String) -> Result<Value, String> {
    read(move || builds::history_list(builder)).await
}
#[tauri::command]
async fn builds_history_detail(
    builder: String,
    reference: String,
    imported_id: Option<String>,
) -> Result<Value, String> {
    read(move || builds::history_detail(builder, reference, imported_id)).await
}
#[tauri::command]
async fn builds_builder_change(
    request: builds::BuilderRequest,
    approved: bool,
) -> Result<Value, String> {
    mutate(move || builds::builder_change(request, approved)).await
}
#[tauri::command]
async fn builds_transfer_start(
    request: builds::TransferRequest,
    approved: bool,
) -> Result<Value, String> {
    mutate(move || builds::transfer_start(request, approved)).await
}
#[tauri::command]
async fn builds_transfer_status(id: String) -> Result<Value, String> {
    read(move || builds::transfer_status(id)).await
}
#[tauri::command]
async fn builds_pick_file(save: bool) -> Result<Value, String> {
    read(move || builds::pick_file(save)).await
}

#[tauri::command]
async fn engine_status() -> Result<Value, String> {
    read(docker::engine_status).await
}
#[tauri::command]
async fn dashboard_snapshot() -> Result<Value, String> {
    read(docker::dashboard_snapshot).await
}
#[tauri::command]
async fn overview() -> Result<Value, String> {
    read(docker::overview).await
}
#[tauri::command]
async fn containers_list() -> Result<Value, String> {
    read(docker::containers_list).await
}
#[tauri::command]
async fn container_inspect(id: String) -> Result<Value, String> {
    read(move || docker::container_inspect(id)).await
}
#[tauri::command]
async fn container_stats(id: String) -> Result<Value, String> {
    read(move || docker::container_stats(id)).await
}
#[tauri::command]
async fn containers_metrics(ids: Vec<String>) -> Result<Value, String> {
    read(move || docker::containers_metrics(ids)).await
}
#[tauri::command]
async fn container_open_port(
    id: String,
    private_port: u16,
    public_port: u16,
) -> Result<Value, String> {
    read(move || docker::container_open_port(id, private_port, public_port)).await
}
#[tauri::command]
async fn container_action(id: String, action: String) -> Result<Value, String> {
    mutate(move || docker::container_action(id, action)).await
}
#[tauri::command]
async fn container_run(
    image_id: String,
    name: String,
    ports: Vec<docker::ContainerPort>,
    options: Option<docker::ContainerOptions>,
) -> Result<Value, String> {
    mutate(move || docker::container_run(image_id, name, ports, options)).await
}
#[tauri::command]
async fn networks_list() -> Result<Value, String> {
    read(resources::networks_list).await
}
#[tauri::command]
async fn network_create(name: String, internal: bool) -> Result<Value, String> {
    mutate(move || docker::network_create(name, internal)).await
}
#[tauri::command]
async fn container_logs(id: String) -> Result<Value, String> {
    read(move || docker::container_logs(id)).await
}
#[tauri::command]
async fn container_logs_start(
    app: tauri::AppHandle,
    id: String,
    stream_id: String,
) -> Result<Value, String> {
    read(move || live_logs::start(app, id, stream_id)).await
}
#[tauri::command]
async fn container_logs_stop(stream_id: String) -> Result<Value, String> {
    read(move || live_logs::stop(stream_id)).await
}
#[tauri::command]
async fn images_list() -> Result<Value, String> {
    read(docker::images_list).await
}
#[tauri::command]
async fn image_details(id: String) -> Result<Value, String> {
    read(move || docker::image_details(id)).await
}
#[tauri::command]
async fn image_search(term: String) -> Result<Value, String> {
    read(move || docker::image_search(term)).await
}
#[tauri::command]
async fn image_pull(
    app: tauri::AppHandle,
    reference: String,
    request_id: Option<String>,
) -> Result<Value, String> {
    let request_id = request_id.unwrap_or_default();
    if request_id.len() > 128
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err("Invalid image pull request identifier".into());
    }
    mutate(move || {
        docker::image_pull_with_progress(reference, move |mut progress| {
            progress["requestId"] = Value::String(request_id.clone());
            let _ = app.emit("image-pull-progress", progress);
        })
    })
    .await
}
#[tauri::command]
async fn image_build_start(
    context_path: String,
    dockerfile: String,
    tag: String,
    no_cache: bool,
) -> Result<Value, String> {
    mutate(move || image_build::start(context_path, dockerfile, tag, no_cache)).await
}
#[tauri::command]
async fn image_build_status(id: String, log_version: Option<u64>) -> Result<Value, String> {
    read(move || image_build::status(id, log_version)).await
}
#[tauri::command]
async fn image_build_pick_context() -> Result<Value, String> {
    read(image_build::pick_context).await
}
#[tauri::command]
async fn disk_usage() -> Result<Value, String> {
    read(docker::disk_usage).await
}
#[tauri::command]
async fn destructive_preview(request: Value) -> Result<Value, String> {
    read(move || docker::destructive_preview(request)).await
}
#[tauri::command]
async fn destructive_execute(token: String, approved: bool) -> Result<Value, String> {
    mutate(move || docker::destructive_execute(token, approved)).await
}
#[tauri::command]
async fn wsl_inventory() -> Result<Value, String> {
    read(wsl::inventory).await
}
#[tauri::command]
async fn wsl_preview(disk_id: String) -> Result<Value, String> {
    read(move || wsl::preview(disk_id)).await
}
#[tauri::command]
async fn wsl_compact(token: String, approved: bool) -> Result<Value, String> {
    mutate(move || wsl::compact(token, approved)).await
}

#[tauri::command]
async fn runtime_status() -> Result<Value, String> {
    read(runtime::status).await
}
#[tauri::command]
async fn runtime_install_preview() -> Result<Value, String> {
    read(runtime::installation_preview).await
}
#[tauri::command]
async fn runtime_install(token: String, approved: bool) -> Result<Value, String> {
    mutate(move || runtime::install(token, approved)).await
}
#[tauri::command]
async fn runtime_start(approved: bool) -> Result<Value, String> {
    mutate(move || runtime::start(approved)).await
}
#[tauri::command]
async fn runtime_stop(approved: bool) -> Result<Value, String> {
    mutate(move || {
        if approved {
            container_tools::close_all();
            live_logs::close_all();
        }
        runtime::stop(approved)
    })
    .await
}

#[tauri::command]
async fn desktop_restart_elevated(app: tauri::AppHandle, approved: bool) -> Result<Value, String> {
    mutate(move || {
        let result = desktop::restart_elevated(approved)?;
        if result["started"] == true {
            EXIT_PENDING.store(true, Ordering::Release);
            app.exit(0);
        }
        Ok(result)
    })
    .await
}

#[tauri::command]
async fn desktop_open_windows_features() -> Result<Value, String> {
    read(desktop::open_windows_features).await
}

fn verify_read_only(report: &str) -> Result<(), String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let output = cwd.join(report);
    if report != "docs/results/native-verification.json" {
        return Err("검증 보고서는 지정된 프로젝트 결과 파일에만 저장할 수 있습니다".into());
    }
    let result = serde_json::json!({
        "engine": docker::engine_status(),
        "containers": docker::containers_list(),
        "images": docker::images_list(),
        "diskUsage": docker::disk_usage(),
        "wsl": wsl::inventory(),
        "invalidDiskPreview": wsl::preview("dockslate-invalid-verification-disk".into()),
        "unapprovedDelete": docker::destructive_execute("invalid-verification-token".into(), false),
        "unapprovedCompact": wsl::compact("invalid-verification-token".into(), false),
        "invalidPull": docker::image_pull("--invalid-reference".into()),
        "runtime": runtime::status(),
        "runtimeInstallPreview": runtime::installation_preview(),
        "unapprovedRuntimeInstall": runtime::install("invalid-verification-token".into(), false),
        "unapprovedRuntimeStart": runtime::start(false),
        "unapprovedRuntimeStop": runtime::stop(false),
        "unapprovedDesktopElevation": desktop::restart_elevated(false),
        "mode": "read-only; no valid mutation token or approved destructive operation"
    });
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(
        output,
        serde_json::to_vec_pretty(&result).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn network_delete_preview(id: String) -> Result<Value, String> {
    mutate(move || resources::network_delete_preview(id)).await
}
#[tauri::command]
async fn network_delete_execute(token: String, approved: bool) -> Result<Value, String> {
    mutate(move || resources::network_delete_execute(token, approved)).await
}
#[tauri::command]
async fn image_removal_preview(
    id: String,
    delete_referencing_containers: bool,
) -> Result<Value, String> {
    read(move || image_removal::preview(id, delete_referencing_containers)).await
}
#[tauri::command]
async fn image_removal_execute(token: String, approved: bool) -> Result<Value, String> {
    mutate(move || image_removal::execute(token, approved)).await
}
#[tauri::command]
async fn compose_pick_file(kind: String) -> Result<Value, String> {
    read(move || compose::pick_file(kind)).await
}
#[tauri::command]
async fn compose_preview(id: String) -> Result<Value, String> {
    read(move || compose::preview(id)).await
}
#[tauri::command]
async fn compose_build_start(id: String) -> Result<Value, String> {
    mutate(move || compose::build_start(id)).await
}
#[tauri::command]
async fn compose_run_preview(id: String) -> Result<Value, String> {
    read(move || compose::run_preview(id)).await
}
#[tauri::command]
async fn compose_run_start(approval: String, approved: bool) -> Result<Value, String> {
    mutate(move || compose::run_start(approval, approved)).await
}
#[tauri::command]
async fn compose_job_status(id: String) -> Result<Value, String> {
    read(move || compose::job_status(id)).await
}
#[tauri::command]
async fn compose_discard(id: String) -> Result<Value, String> {
    read(move || compose::discard(id)).await
}

fn main() {
    let mut arguments = std::env::args().skip(1);
    let first = arguments.next();
    if first.as_deref() == Some("--dockslate-elevated") {
        if arguments.next().is_some() || desktop::prepare_elevated_startup().is_err() {
            std::process::exit(1);
        }
    }
    if first.as_deref() == Some("--verify-read-only") {
        let report = arguments
            .next()
            .unwrap_or_else(|| "docs/results/native-verification.json".into());
        if let Err(error) = verify_read_only(&report) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
 network_delete_preview, network_delete_execute, image_removal_preview, image_removal_execute, compose_pick_file, compose_preview, compose_build_start, compose_run_preview, compose_run_start, compose_job_status, compose_discard,
            volumes_list, volume_inspect, volume_create, volume_clone, volume_browse, volume_file_preview,
            volume_pick_archive, volume_export, volume_import_preview, volume_destructive_preview, volume_execute, volume_discard_preview, volume_job_status,
            builds_snapshot, builds_builder_inspect, builds_history_list, builds_history_detail, builds_builder_change, builds_transfer_start, builds_transfer_status, builds_pick_file,
            container_files,
            container_file_preview,
            terminal_open, terminal_read, terminal_input, terminal_resize, terminal_close,
            engine_status,
            dashboard_snapshot,
            overview,
            containers_list,
            container_inspect,
            container_stats,
            containers_metrics,
            container_open_port,
            container_action,
            container_run,
            networks_list,
            network_create,
            container_logs,
            container_logs_start,
            container_logs_stop,
            images_list,
            image_details,
            image_search,
            image_pull,
            image_build_start,
            image_build_status,
            image_build_pick_context,
            disk_usage,
            destructive_preview,
            destructive_execute,
            wsl_inventory,
            wsl_preview,
            wsl_compact,
            runtime_status,
            runtime_install_preview,
            runtime_install,
            runtime_start,
            runtime_stop,
            desktop_restart_elevated,
            desktop_open_windows_features
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if docker::is_pulling() {
                    api.prevent_close();
                    let _ = window.emit("close-blocked", "An image download is running. Wait for it to finish before closing DockSlate.");
                } else if image_build::is_building() {
                    api.prevent_close();
                    let _ = window.emit("close-blocked", "이미지 빌드가 진행 중입니다. 완료 후 앱을 종료할 수 있습니다.");
                } else if volumes::is_busy() || builds::is_busy() || compose::is_busy() {
                    api.prevent_close();
                    let _ = window.emit("close-blocked", "파일 전송 중입니다. 완료 후 앱을 종료할 수 있습니다.");
                } else if wsl::is_compacting() {
                    api.prevent_close();
                    let _ = window.emit(
                        "close-blocked",
                        "VHDX 압축이 진행 중이므로 앱을 종료할 수 없습니다.",
                    );
                } else if runtime::is_mutating() {
                    api.prevent_close();
                    let _ = window.emit(
                        "close-blocked",
                        "엔진 설치 또는 상태 변경이 진행 중입니다. 완료 결과를 확인할 때까지 앱을 종료할 수 없습니다.",
                    );
                } else { container_tools::close_all(); live_logs::close_all(); }
            }
        })
        .run(tauri::generate_context!())
        .expect("DockSlate Windows 실행 실패");
}
