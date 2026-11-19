use crate::{compose, desktop, docker, image_removal, resources, runtime, volumes, wsl};
use serde_json::Value;

fn approval_denied(result: Result<Value, String>) {
    let error = result.expect_err("Unapproved operation must fail before accessing an engine");
    assert!(error.to_ascii_lowercase().contains("approval") || error.contains("승인"), "Expected an approval denial, got {error}");
}

#[test]
fn unapproved_operations_stop_before_system_changes() {
    approval_denied(runtime::install("invalid".into(), false, false));
    approval_denied(runtime::start(false));
    approval_denied(runtime::stop(false));
    approval_denied(desktop::restart_elevated(false));
    approval_denied(wsl::compact("invalid".into(), false));
    approval_denied(docker::destructive_execute("invalid".into(), false, |_| {}));
    approval_denied(volumes::execute("invalid".into(), false));
    approval_denied(compose::run_start("invalid".into(), false));
}

#[test]
fn approval_boolean_does_not_replace_a_valid_token() {
    let token = "0".repeat(64);
    approval_denied(docker::destructive_execute(token.clone(), true, |_| {}));
    approval_denied(resources::network_delete_execute(token.clone(), true));
    approval_denied(image_removal::execute(token.clone(), true));
    approval_denied(volumes::execute(token, true));
}

#[test]
fn network_names_are_validated_before_engine_access() {
    for name in ["", "bridge", "host", "none", "../network", "network\n", "-option"] {
        let error = resources::network_create(name.into(), false).expect_err("Invalid network name accepted");
        assert!(error.contains("네트워크 이름"), "Unexpected system access: {error}");
    }
}
