use serde_json::{json, Value};

pub fn prepare_elevated_startup() -> Result<(), String> {
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("WEBVIEW2_")
        {
            std::env::remove_var(key);
        }
    }
    #[cfg(windows)]
    windows::configure_elevated_profile()?;
    Ok(())
}

pub fn restart_elevated(approved: bool) -> Result<Value, String> {
    if !approved {
        return Err("관리자 권한으로 다시 실행하려면 명시적인 승인이 필요합니다.".into());
    }
    #[cfg(windows)]
    {
        windows::restart_elevated()
    }
    #[cfg(not(windows))]
    {
        Err("관리자 권한 실행은 Windows에서만 지원합니다.".into())
    }
}

pub fn open_windows_features() -> Result<Value, String> {
    #[cfg(windows)]
    {
        windows::open_windows_features()
    }
    #[cfg(not(windows))]
    {
        Err("Windows 기능 설정은 Windows에서만 열 수 있습니다.".into())
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        ffi::{c_void, OsString},
        os::windows::{
            ffi::{OsStrExt, OsStringExt},
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        path::{Path, PathBuf},
        thread,
        time::{Duration, Instant},
    };

    type Handle = *mut c_void;
    #[repr(C)]
    struct ShellExecuteInfo {
        size: u32,
        mask: u32,
        window: Handle,
        verb: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
        instance: Handle,
        id_list: Handle,
        class: *const u16,
        class_key: Handle,
        hot_key: u32,
        icon: Handle,
        process: Handle,
    }
    #[repr(C)]
    struct Guid {
        a: u32,
        b: u16,
        c: u16,
        d: [u8; 8],
    }
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteExW(info: *mut ShellExecuteInfo) -> i32;
        fn SHGetKnownFolderPath(
            id: *const Guid,
            flags: u32,
            token: Handle,
            path: *mut *mut u16,
        ) -> i32;
    }
    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoTaskMemFree(memory: *mut c_void);
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
        fn GetCurrentProcess() -> Handle;
        fn GetProcessId(process: Handle) -> u32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn QueryFullProcessImageNameW(
            process: Handle,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
        fn GetTokenInformation(
            token: Handle,
            class: u32,
            information: *mut c_void,
            size: u32,
            returned: *mut u32,
        ) -> i32;
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumWindows(
            callback: unsafe extern "system" fn(Handle, isize) -> i32,
            data: isize,
        ) -> i32;
        fn GetWindowThreadProcessId(window: Handle, process: *mut u32) -> u32;
        fn IsWindowVisible(window: Handle) -> i32;
    }

    fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
        value.as_ref().encode_wide().chain(Some(0)).collect()
    }
    pub fn configure_elevated_profile() -> Result<(), String> {
        let local_app_data = Guid {
            a: 0xf1b32785,
            b: 0x6fba,
            c: 0x4fcf,
            d: [0x9d, 0x55, 0x7b, 0x8e, 0x7f, 0x15, 0x70, 0x91],
        };
        let mut path = std::ptr::null_mut();
        if unsafe { SHGetKnownFolderPath(&local_app_data, 0, std::ptr::null_mut(), &mut path) } < 0
            || path.is_null()
        {
            return Err("관리자 창의 앱 데이터 폴더를 확인할 수 없습니다.".into());
        }
        let mut length = 0usize;
        while length < 32768 && unsafe { *path.add(length) } != 0 {
            length += 1;
        }
        let directory = if length < 32768 {
            Some(PathBuf::from(OsString::from_wide(unsafe {
                std::slice::from_raw_parts(path, length)
            })))
        } else {
            None
        };
        unsafe { CoTaskMemFree(path.cast()) };
        let directory = directory.ok_or("관리자 창의 앱 데이터 경로가 너무 깁니다.")?;
        std::env::set_var(
            "WEBVIEW2_USER_DATA_FOLDER",
            directory.join("DockSlate").join("WebView2-admin"),
        );
        Ok(())
    }
    fn system_directory() -> Result<PathBuf, String> {
        let mut buffer = vec![0u16; 32768];
        let size = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if size == 0 || size as usize >= buffer.len() {
            return Err("Windows 시스템 폴더를 확인할 수 없습니다.".into());
        }
        Ok(PathBuf::from(OsString::from_wide(&buffer[..size as usize])))
    }
    fn elevated(process: Handle) -> Result<bool, String> {
        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(process, 8, &mut token) } == 0 {
            return Err("실행 권한을 확인할 수 없습니다.".into());
        }
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut elevation = 0u32;
        let mut returned = 0;
        if unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                20,
                (&mut elevation as *mut u32).cast(),
                std::mem::size_of::<u32>() as u32,
                &mut returned,
            )
        } == 0
            || returned != std::mem::size_of::<u32>() as u32
        {
            return Err("관리자 권한 상태를 확인할 수 없습니다.".into());
        }
        Ok(elevation != 0)
    }
    fn launch(program: &Path, verb: &str, parameters: Option<&str>) -> Result<OwnedHandle, String> {
        if !program.is_absolute() || !program.is_file() {
            return Err("실행할 Windows 프로그램 파일을 확인할 수 없습니다.".into());
        }
        let file = wide(program);
        let verb = wide(verb);
        let parameters = parameters.map(wide);
        let directory = wide(
            program
                .parent()
                .ok_or("프로그램 폴더를 확인할 수 없습니다.")?,
        );
        let mut info: ShellExecuteInfo = unsafe { std::mem::zeroed() };
        info.size = std::mem::size_of::<ShellExecuteInfo>() as u32;
        info.mask = 0x40 | 0x100;
        info.verb = verb.as_ptr();
        info.file = file.as_ptr();
        info.parameters = parameters
            .as_ref()
            .map_or(std::ptr::null(), |value| value.as_ptr());
        info.directory = directory.as_ptr();
        info.show = 1;
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            let error = std::io::Error::last_os_error();
            return Err(if error.raw_os_error() == Some(1223) {
                "권한 요청을 취소했습니다. 현재 DockSlate 창을 유지합니다.".into()
            } else {
                format!("프로그램을 실행하지 못했습니다: {error}")
            });
        }
        if info.process.is_null() {
            return Err("새 프로세스를 확인할 수 없습니다. 현재 DockSlate 창을 유지합니다.".into());
        }
        Ok(unsafe { OwnedHandle::from_raw_handle(info.process) })
    }
    struct WindowProbe {
        process_id: u32,
        visible: bool,
    }
    unsafe extern "system" fn visible_window(window: Handle, data: isize) -> i32 {
        let probe = unsafe { &mut *(data as *mut WindowProbe) };
        let mut process_id = 0;
        unsafe { GetWindowThreadProcessId(window, &mut process_id) };
        if process_id == probe.process_id && unsafe { IsWindowVisible(window) } != 0 {
            probe.visible = true;
            return 0;
        }
        1
    }
    pub fn restart_elevated() -> Result<Value, String> {
        if elevated(unsafe { GetCurrentProcess() })? {
            return Ok(json!({"started":false,"message":"이미 관리자 권한으로 실행 중입니다."}));
        }
        let current = std::env::current_exe()
            .map_err(|_| "현재 DockSlate 실행 파일을 확인할 수 없습니다.")?;
        let process = launch(&current, "runas", Some("--dockslate-elevated"))?;
        let process_id = unsafe { GetProcessId(process.as_raw_handle()) };
        let mut program = vec![0u16; 32768];
        let mut size = program.len() as u32;
        if process_id == 0
            || unsafe {
                QueryFullProcessImageNameW(
                    process.as_raw_handle(),
                    0,
                    program.as_mut_ptr(),
                    &mut size,
                )
            } == 0
            || PathBuf::from(OsString::from_wide(&program[..size as usize])) != current
            || !elevated(process.as_raw_handle())?
        {
            return Err("새 관리자 프로세스의 실행 파일과 권한을 확인하지 못했습니다. 현재 창을 유지합니다.".into());
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } != 258 {
                return Err(
                    "새 관리자 프로세스가 종료되었습니다. 현재 DockSlate 창을 유지합니다.".into(),
                );
            }
            let mut probe = WindowProbe {
                process_id,
                visible: false,
            };
            unsafe { EnumWindows(visible_window, (&mut probe as *mut WindowProbe) as isize) };
            if probe.visible {
                return Ok(json!({"started":true,"message":"새 관리자 창을 확인했습니다."}));
            }
            if Instant::now() >= deadline {
                return Err("새 관리자 창을 확인하지 못했습니다. 현재 창을 유지합니다. 새 창이 열렸는지 확인하세요.".into());
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    pub fn open_windows_features() -> Result<Value, String> {
        let _process = launch(
            &system_directory()?.join("optionalfeatures.exe"),
            "open",
            None,
        )?;
        Ok(json!({"opened":true,"message":"Windows 기능 설정을 열었습니다."}))
    }
}
