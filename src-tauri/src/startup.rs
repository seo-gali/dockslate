use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

static CHANGE: Mutex<()> = Mutex::new(());

#[derive(Default)]
struct Settings {
    start_engine: bool,
    start_app: bool,
    conflict: bool,
    executable: String,
}
impl Settings {
    fn mode(&self) -> Option<&'static str> {
        match (self.start_engine, self.start_app) {
            (true, true) => Some("both"),
            (true, false) => Some("engine"),
            (false, true) => Some("app"),
            _ => None,
        }
    }
    fn value(&self) -> Value {
        json!({"startEngine":self.start_engine,"startApp":self.start_app,"conflict":self.conflict,"executable":self.executable})
    }
}

pub fn settings() -> Result<Value, String> {
    platform(None).map(|settings| settings.value())
}
pub fn set(start_engine: bool, start_app: bool) -> Result<Value, String> {
    let _guard = CHANGE
        .lock()
        .map_err(|_| "자동 시작 설정을 변경하고 있습니다.")?;
    platform(Some((start_engine, start_app))).map(|settings| settings.value())
}
pub fn from_login(mode: &str) -> Result<bool, String> {
    if !["engine", "app", "both"].contains(&mode) {
        return Err("지원하지 않는 자동 시작 방식입니다.".into());
    }
    let settings = platform(None)?;
    if settings.conflict || settings.mode() != Some(mode) {
        return Ok(false);
    }
    if settings.start_app {
        return Ok(true);
    }
    let current = crate::runtime::status()?;
    if current["state"] == "stopped" {
        crate::runtime::start(true)?;
    } else if current["state"] != "running" && current["state"] != "starting" {
        return Err(current["message"]
            .as_str()
            .unwrap_or("전용 엔진을 시작할 수 없습니다.")
            .into());
    }
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        let status = crate::runtime::status()?;
        if status["state"] == "running" {
            let engine = crate::docker::engine_status()?;
            if engine["state"] != "connected" {
                return Err(engine["message"]
                    .as_str()
                    .unwrap_or("엔진 연결을 확인하지 못했습니다.")
                    .into());
            }
            return Ok(false);
        }
        if ![Some("starting"), Some("stopped")].contains(&status["state"].as_str())
            || Instant::now() >= deadline
        {
            return Err(status["message"]
                .as_str()
                .unwrap_or("엔진 자동 시작을 완료하지 못했습니다.")
                .into());
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[cfg(not(windows))]
fn platform(_: Option<(bool, bool)>) -> Result<Settings, String> {
    Err("Windows 자동 시작은 Windows에서만 설정할 수 있습니다.".into())
}

#[cfg(windows)]
fn platform(change: Option<(bool, bool)>) -> Result<Settings, String> {
    windows::settings(change)
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{ffi::c_void, os::windows::ffi::OsStrExt};
    type Handle = *mut c_void;
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegOpenKeyExW(
            key: Handle,
            name: *const u16,
            options: u32,
            access: u32,
            result: *mut Handle,
        ) -> i32;
        fn RegCreateKeyExW(
            key: Handle,
            name: *const u16,
            reserved: u32,
            class: *mut u16,
            options: u32,
            access: u32,
            security: *const c_void,
            result: *mut Handle,
            disposition: *mut u32,
        ) -> i32;
        fn RegQueryValueExW(
            key: Handle,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            size: *mut u32,
        ) -> i32;
        fn RegSetValueExW(
            key: Handle,
            name: *const u16,
            reserved: u32,
            kind: u32,
            data: *const u8,
            size: u32,
        ) -> i32;
        fn RegDeleteValueW(key: Handle, name: *const u16) -> i32;
        fn RegCloseKey(key: Handle) -> i32;
    }
    struct Key(Handle);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    fn command(prefix: &[u16], mode: Option<&str>) -> Vec<u16> {
        prefix
            .iter()
            .copied()
            .chain(
                mode.map(|mode| format!(" --startup {mode}"))
                    .unwrap_or_default()
                    .encode_utf16(),
            )
            .chain(Some(0))
            .collect()
    }
    fn same_command(actual: &[u16], expected: &[u16], prefix_len: usize) -> bool {
        let fold = |value: u16| {
            if (65..=90).contains(&value) {
                value + 32
            } else {
                value
            }
        };
        actual.len() == expected.len()
            && actual
                .iter()
                .take(prefix_len)
                .map(|value| fold(*value))
                .eq(expected.iter().take(prefix_len).map(|value| fold(*value)))
            && actual[prefix_len..] == expected[prefix_len..]
    }
    fn read(key: Handle, prefix: &[u16], executable: &str) -> Result<Settings, String> {
        let name = wide("DockSlate");
        let mut kind = 0;
        let mut size = 0;
        let status = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if status == 2 {
            return Ok(Settings {
                executable: executable.into(),
                ..Settings::default()
            });
        }
        if status != 0 {
            return Err(format!(
                "Windows 자동 시작 등록을 읽지 못했습니다. 코드 {status}"
            ));
        }
        let mut result = Settings {
            executable: executable.into(),
            conflict: true,
            ..Settings::default()
        };
        let choices = [
            (Some("engine"), true, false),
            (Some("app"), false, true),
            (Some("both"), true, true),
            (None, false, true),
        ];
        if kind != 1
            || !choices
                .iter()
                .any(|(mode, _, _)| command(prefix, *mode).len() * 2 == size as usize)
        {
            return Ok(result);
        }
        let mut data = vec![0u16; size as usize / 2];
        let status = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                data.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != 0 || kind != 1 || size as usize != data.len() * 2 {
            return Err("Windows 자동 시작 등록이 바뀌었습니다. 다시 확인하세요.".into());
        }
        for (mode, engine, app) in choices {
            if same_command(&data, &command(prefix, mode), prefix.len()) {
                result.start_engine = engine;
                result.start_app = app;
                result.conflict = false;
                break;
            }
        }
        Ok(result)
    }
    pub(super) fn settings(change: Option<(bool, bool)>) -> Result<Settings, String> {
        let executable =
            std::env::current_exe().map_err(|_| "현재 실행 파일 경로를 확인할 수 없습니다.")?;
        let prefix: Vec<u16> = Some(34)
            .into_iter()
            .chain(executable.as_os_str().encode_wide())
            .chain(Some(34))
            .collect();
        let display = executable.display().to_string();
        let subkey = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
        let name = wide("DockSlate");
        let current_user = 0x80000001u32 as i32 as isize as Handle;
        let mut handle = std::ptr::null_mut();
        let access = if change.is_some() { 3 } else { 1 };
        let mut status =
            unsafe { RegOpenKeyExW(current_user, subkey.as_ptr(), 0, access, &mut handle) };
        if status == 2 {
            if change.is_none() || change == Some((false, false)) {
                return Ok(Settings {
                    executable: display,
                    ..Settings::default()
                });
            }
            status = unsafe {
                RegCreateKeyExW(
                    current_user,
                    subkey.as_ptr(),
                    0,
                    std::ptr::null_mut(),
                    0,
                    access,
                    std::ptr::null(),
                    &mut handle,
                    std::ptr::null_mut(),
                )
            };
        }
        if status != 0 {
            return Err(format!(
                "Windows 자동 시작 설정에 접근할 수 없습니다. 코드 {status}"
            ));
        }
        let key = Key(handle);
        let previous = read(key.0, &prefix, &display)?;
        let Some((engine, app)) = change else {
            return Ok(previous);
        };
        if previous.conflict {
            return Err(
                "다른 실행 파일의 DockSlate 자동 시작 등록이 있습니다. 기존 등록은 보존했습니다."
                    .into(),
            );
        }
        let desired = Settings {
            start_engine: engine,
            start_app: app,
            executable: display.clone(),
            conflict: false,
        };
        if let Some(mode) = desired.mode() {
            let data = command(&prefix, Some(mode));
            if data.len() > 261 {
                return Err("실행 파일 경로가 길어 Windows 자동 시작에 등록할 수 없습니다.".into());
            }
            status = unsafe {
                RegSetValueExW(
                    key.0,
                    name.as_ptr(),
                    0,
                    1,
                    data.as_ptr().cast(),
                    (data.len() * 2) as u32,
                )
            };
        } else {
            status = unsafe { RegDeleteValueW(key.0, name.as_ptr()) };
        }
        if status != 0 && !(desired.mode().is_none() && status == 2) {
            return Err(format!(
                "Windows 자동 시작 설정을 저장하지 못했습니다. 코드 {status}"
            ));
        }
        let actual = read(key.0, &prefix, &display)?;
        if actual.conflict || actual.start_engine != engine || actual.start_app != app {
            return Err(
                "Windows 자동 시작 저장 결과를 확인하지 못했습니다. 다시 확인하세요.".into(),
            );
        }
        Ok(actual)
    }
}
