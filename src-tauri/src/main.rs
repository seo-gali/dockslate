#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop;
mod docker;
mod image_build;
mod process;
mod runtime;
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
        if image_build::is_building() {
            return Err("이미지 빌드가 진행 중입니다. 완료 후 다시 시도하세요.".into());
        }
        operation()
    })
    .await
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
    read(docker::networks_list).await
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
async fn image_pull(reference: String) -> Result<Value, String> {
    mutate(move || docker::image_pull(reference)).await
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
    mutate(move || runtime::stop(approved)).await
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
            engine_status,
            dashboard_snapshot,
            overview,
            containers_list,
            container_action,
            container_run,
            networks_list,
            network_create,
            container_logs,
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
                if image_build::is_building() {
                    api.prevent_close();
                    let _ = window.emit("close-blocked", "이미지 빌드가 진행 중입니다. 완료 후 앱을 종료할 수 있습니다.");
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
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("DockSlate Windows 실행 실패");
}
