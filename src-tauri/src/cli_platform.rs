use std::path::Path;

#[cfg(windows)]
pub(crate) mod native {
    use std::{
        ffi::c_void,
        path::Path,
        ptr::{null, null_mut},
        thread,
        time::{Duration, Instant},
    };
    pub(crate) type RawHandle = *mut c_void;
    pub(crate) struct Handle(pub(crate) isize);
    impl Handle {
        pub(crate) fn raw(&self) -> RawHandle {
            self.0 as RawHandle
        }
    }
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.raw());
            }
        }
    }
    #[repr(C)]
    struct StartupInfo {
        size: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        columns: u32,
        rows: u32,
        fill: u32,
        flags: u32,
        show: u16,
        reserved_size: u16,
        reserved_bytes: *mut u8,
        input: RawHandle,
        output: RawHandle,
        error: RawHandle,
    }
    #[repr(C)]
    struct ProcessInfo {
        process: RawHandle,
        thread: RawHandle,
        process_id: u32,
        thread_id: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub(crate) fn CloseHandle(handle: RawHandle) -> i32;
        fn GetCurrentProcess() -> RawHandle;
        fn GetLastError() -> u32;
        fn LocalFree(memory: RawHandle) -> RawHandle;
        fn CreateProcessW(
            application: *const u16,
            command: *mut u16,
            process_security: RawHandle,
            thread_security: RawHandle,
            inherit: i32,
            flags: u32,
            environment: RawHandle,
            directory: *const u16,
            startup: *mut StartupInfo,
            process: *mut ProcessInfo,
        ) -> i32;
        fn GetExitCodeProcess(process: RawHandle, code: *mut u32) -> i32;
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *const c_void,
            disposition: u32,
            flags: u32,
            template: RawHandle,
        ) -> RawHandle;
        fn GetNamedPipeServerProcessId(pipe: RawHandle, pid: *mut u32) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> RawHandle;
        fn QueryFullProcessImageNameW(
            process: RawHandle,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: RawHandle, access: u32, token: *mut RawHandle) -> i32;
        fn GetTokenInformation(
            token: RawHandle,
            kind: u32,
            info: *mut c_void,
            size: u32,
            required: *mut u32,
        ) -> i32;
        fn ConvertSidToStringSidW(sid: RawHandle, string: *mut *mut u16) -> i32;
    }
    pub(crate) fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    pub(crate) fn error(action: &str) -> String {
        format!("{action}: Windows error {}", unsafe { GetLastError() })
    }
    fn process_sid(process: RawHandle) -> Result<String, String> {
        let mut token = null_mut();
        if unsafe { OpenProcessToken(process, 0x0008, &mut token) } == 0 {
            return Err(error("Cannot verify the pipe user's token"));
        }
        let token = Handle(token as isize);
        let mut required = 0;
        unsafe {
            GetTokenInformation(token.raw(), 1, null_mut(), 0, &mut required);
        }
        if required == 0 || required > 65536 {
            return Err("The pipe user's token has an invalid size".into());
        }
        let mut information =
            vec![0usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe {
            GetTokenInformation(
                token.raw(),
                1,
                information.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(error("Cannot read the pipe user's SID"));
        }
        let sid = information[0] as RawHandle;
        let mut string = null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut string) } == 0 {
            return Err(error("Cannot format the pipe user's SID"));
        }
        let mut len = 0;
        unsafe {
            while len < 256 && *string.add(len) != 0 {
                len += 1;
            }
        }
        let result = if len < 256 {
            unsafe { String::from_utf16(std::slice::from_raw_parts(string, len)) }
                .map_err(|_| "The pipe user's SID is invalid".to_owned())
        } else {
            Err("The pipe user's SID is too long".into())
        };
        unsafe {
            LocalFree(string.cast());
        }
        result
    }
    pub(crate) fn current_sid() -> Result<String, String> {
        process_sid(unsafe { GetCurrentProcess() })
    }
    pub(crate) fn pipe_name() -> Result<String, String> {
        Ok(format!(r"\\.\pipe\dockslate_engine_{}", current_sid()?))
    }
    enum Probe {
        Ready,
        Missing,
        Busy,
    }
    fn probe(expected: &Path) -> Result<Probe, String> {
        let raw = unsafe {
            CreateFileW(
                wide(&pipe_name()?).as_ptr(),
                0xc0000000,
                0,
                null(),
                3,
                0x40000000 | 0x00100000,
                null_mut(),
            )
        };
        if raw as isize == -1 {
            return match unsafe { GetLastError() } {
                2 => Ok(Probe::Missing),
                231 => Ok(Probe::Busy),
                _ => Err(error("Cannot access the DockSlate pipe")),
            };
        }
        let pipe = Handle(raw as isize);
        let mut pid = 0;
        if unsafe { GetNamedPipeServerProcessId(pipe.raw(), &mut pid) } == 0 {
            return Err(error("Cannot verify the DockSlate pipe server"));
        }
        let raw = unsafe { OpenProcess(0x1000, 0, pid) };
        if raw.is_null() {
            return Err(error("Cannot inspect the DockSlate pipe server"));
        }
        let process = Handle(raw as isize);
        if process_sid(process.raw())? != current_sid()? {
            return Err("The existing DockSlate pipe belongs to another user".into());
        }
        let mut image = vec![0u16; 32768];
        let mut size = image.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process.raw(), 0, image.as_mut_ptr(), &mut size) }
            == 0
        {
            return Err(error("Cannot inspect the DockSlate pipe executable"));
        }
        let image = String::from_utf16(&image[..size as usize])
            .map_err(|_| "The DockSlate pipe executable path is invalid")?;
        let actual = Path::new(&image)
            .canonicalize()
            .map_err(|_| "The DockSlate pipe executable cannot be verified")?;
        if !actual
            .to_string_lossy()
            .eq_ignore_ascii_case(&expected.to_string_lossy())
        {
            return Err("The existing DockSlate pipe is owned by a different executable".into());
        }
        Ok(Probe::Ready)
    }
    pub(crate) fn ensure_proxy(app_exe: &Path) -> Result<(), String> {
        let expected = app_exe
            .canonicalize()
            .map_err(|_| "The DockSlate application executable is unavailable")?;
        if !expected.is_file() {
            return Err("The DockSlate application executable is unavailable".into());
        }
        let mut child = None;
        match probe(&expected)? {
            Probe::Ready => return Ok(()),
            Probe::Missing => {
                let application = expected
                    .to_str()
                    .ok_or("Invalid DockSlate executable path")?;
                let mut command = wide(&format!("\"{application}\" --engine-proxy"));
                let mut startup: StartupInfo = unsafe { std::mem::zeroed() };
                startup.size = std::mem::size_of::<StartupInfo>() as u32;
                let mut process: ProcessInfo = unsafe { std::mem::zeroed() };
                // The broker must not keep the caller's redirected pipes open.
                if unsafe {
                    CreateProcessW(
                        wide(application).as_ptr(),
                        command.as_mut_ptr(),
                        null_mut(),
                        null_mut(),
                        0,
                        0x08000000 | 0x00000200,
                        null_mut(),
                        null(),
                        &mut startup,
                        &mut process,
                    )
                } == 0
                {
                    return Err(error("Cannot launch the DockSlate pipe broker"));
                }
                drop(Handle(process.thread as isize));
                child = Some(Handle(process.process as isize));
            }
            Probe::Busy => {}
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match probe(&expected)? {
                Probe::Ready => return Ok(()),
                Probe::Missing | Probe::Busy => {}
            }
            if let Some(child) = child.as_ref() {
                let mut status = 0;
                if unsafe { GetExitCodeProcess(child.raw(), &mut status) } == 0 {
                    return Err(error("Cannot inspect the DockSlate pipe broker"));
                }
                if status != 259 {
                    return Err(format!(
                        "The DockSlate pipe broker exited before readiness ({status})"
                    ));
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        Err("The DockSlate pipe broker did not become ready within 10 seconds".into())
    }
}

pub(crate) fn endpoint() -> Result<String, String> {
    #[cfg(windows)]
    {
        Ok(format!(
            "npipe:////./pipe/dockslate_engine_{}",
            native::current_sid()?
        ))
    }
    #[cfg(not(windows))]
    {
        Err("The DockSlate Windows CLI requires Windows 11".into())
    }
}

pub(crate) fn ensure_proxy(app_exe: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        native::ensure_proxy(app_exe)
    }
    #[cfg(not(windows))]
    {
        let _ = app_exe;
        Err("The DockSlate pipe broker requires Windows 11".into())
    }
}
