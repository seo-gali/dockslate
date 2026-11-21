use crate::{compose, desktop, docker, image_removal, resources, runtime, volumes, wsl};
use serde_json::Value;

#[cfg(windows)]
#[test]
fn runtime_fingerprint_compares_windows_path_identity_without_ignoring_ownership() {
    let expected = serde_json::json!({
        "installPath": r"C:\Users\example\AppData\Local\DockSlateData\runtime\wsl",
        "registrationId":"registration-1", "installId":"installation-1",
        "engineVersion":"engine-1", "rootfsSha256":"rootfs-1"
    });
    assert!(runtime::same_ownership_fingerprint(&expected, &expected));
    for path in [
        r"\\?\C:\Users\example\AppData\Local\DockSlateData\runtime\wsl",
        r"c:\users\example\appdata\local\dockslatedata\runtime\wsl\",
        r"C:\Users\example\AppData\Local\DockSlateData\runtime\.\wsl",
    ] {
        let mut current = expected.clone(); current["installPath"] = path.into();
        assert!(runtime::same_ownership_fingerprint(&expected,&current), "Same Windows path rejected: {path}");
    }
    for (plain, extended) in [
        (r"D:\Applications\DockSlate data\runtime\wsl", r"\\?\d:\applications\DockSlate data\runtime\wsl\"),
        (r"Z:\사용자\홍 길동\DockSlateData\runtime\wsl", r"\\?\Z:\사용자\홍 길동\DockSlateData\runtime\wsl"),
    ] {
        let mut expected = expected.clone();expected["installPath"]=plain.into();
        let mut current = expected.clone();current["installPath"]=extended.into();
        assert!(runtime::same_ownership_fingerprint(&expected,&current), "Custom installation path rejected");
    }
    for (field,value) in [
        ("installPath",r"C:\Users\other\AppData\Local\DockSlateData\runtime\wsl"),
        ("installPath",r"relative\wsl"), ("registrationId","registration-2"),
        ("installId","installation-2"), ("engineVersion","engine-2"), ("rootfsSha256","rootfs-2"),
    ] {
        let mut current=expected.clone();current[field]=value.into();
        assert!(!runtime::same_ownership_fingerprint(&expected,&current), "Different {field} accepted");
    }
    let mut missing=expected.clone();missing.as_object_mut().unwrap().remove("registrationId");
    assert!(!runtime::same_ownership_fingerprint(&expected,&missing));
    assert!(!runtime::same_ownership_fingerprint(&serde_json::json!({}),&serde_json::json!({})));
    assert!(!runtime::same_ownership_fingerprint(&Value::Null,&Value::Null));
    let mut invalid=expected.clone();invalid["installPath"]="relative\\wsl".into();
    assert!(!runtime::same_ownership_fingerprint(&invalid,&invalid));
    let mut extra=expected.clone();extra["unverifiedField"]=true.into();
    assert!(!runtime::same_ownership_fingerprint(&expected,&extra));
}

#[cfg(windows)]
#[test]
fn installer_cli_failure_keeps_diagnostics_and_requires_output_even_after_exit_zero() {
    use std::{os::windows::process::ExitStatusExt, process::{ExitStatus, Output}};
    let output = |code, stdout: &[u8], stderr: &[u8]| Ok(Output {
        status: ExitStatus::from_raw(code), stdout: stdout.to_vec(), stderr: stderr.to_vec(),
    });
    let args = ["info","--format","{{.ID}}"];
    assert_eq!(crate::installer_cli_output(&args,output(0,b"engine-id\r\n",b"")).unwrap(),"engine-id");
    for code in [0,125] {
        let error=crate::installer_cli_output(&args,output(code,b"",b"The owned runtime stopped or its ownership changed.")).unwrap_err();
        assert!(error.contains("info --format {{.ID}}"));
        assert!(error.contains(&format!("Exit code: {code}")));
        assert!(error.contains("The owned runtime stopped or its ownership changed."));
        assert!(error.contains("Setup is not complete."));
    }
    assert!(crate::installer_cli_output(&args,output(0,b" \r\n",b"")).unwrap_err().contains("Required output is missing"));
    assert!(crate::installer_cli_output(&args,output(0,"\u{2003}\r\n".as_bytes(),b"")).unwrap_err().contains("Required output is missing"));
    assert!(crate::installer_cli_output(&args,output(0,b"\xff",b"")).unwrap_err().contains("invalid UTF-8"));
    assert!(crate::installer_cli_output(&args,Err("Command timed out".into())).unwrap_err().contains("Command timed out"));
    let long="한".repeat(3000);
    let error=crate::installer_cli_output(&args,output(125,b"",long.as_bytes())).unwrap_err();
    assert_eq!(error.chars().filter(|c| *c=='한').count(),2000);
}

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
    approval_denied(crate::migration::execute("invalid".into(), false));
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
