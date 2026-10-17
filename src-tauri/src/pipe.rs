use std::{
    ffi::c_void,
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    time::{Duration, Instant},
};

type Handle = *mut c_void;
#[repr(C)]
struct Overlapped {
    internal: usize,
    internal_high: usize,
    offset: u32,
    offset_high: u32,
    event: Handle,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: *const c_void,
        disposition: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
    fn CreateEventW(security: *const c_void, manual: i32, initial: i32, name: *const u16)
        -> Handle;
    fn ReadFile(
        handle: Handle,
        data: *mut c_void,
        len: u32,
        read: *mut u32,
        overlapped: *mut Overlapped,
    ) -> i32;
    fn WriteFile(
        handle: Handle,
        data: *const c_void,
        len: u32,
        written: *mut u32,
        overlapped: *mut Overlapped,
    ) -> i32;
    fn GetOverlappedResult(
        handle: Handle,
        overlapped: *mut Overlapped,
        transferred: *mut u32,
        wait: i32,
    ) -> i32;
    fn WaitForSingleObject(handle: Handle, timeout: u32) -> u32;
    fn CancelIoEx(handle: Handle, overlapped: *mut Overlapped) -> i32;
    fn GetLastError() -> u32;
    fn GetNamedPipeServerProcessId(pipe: Handle, process_id: *mut u32) -> i32;
    fn OpenProcess(access: u32, inherit: i32, id: u32) -> Handle;
    fn QueryFullProcessImageNameW(
        process: Handle,
        flags: u32,
        path: *mut u16,
        size: *mut u32,
    ) -> i32;
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn RegOpenKeyExW(
        key: Handle,
        subkey: *const u16,
        options: u32,
        access: u32,
        result: *mut Handle,
    ) -> i32;
    fn RegEnumKeyExW(
        key: Handle,
        index: u32,
        name: *mut u16,
        len: *mut u32,
        reserved: *mut u32,
        class: *mut u16,
        class_len: *mut u32,
        time: *mut c_void,
    ) -> i32;
    fn RegQueryValueExW(
        key: Handle,
        value: *const u16,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        len: *mut u32,
    ) -> i32;
    fn RegCloseKey(key: Handle) -> i32;
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn last_error(operation: &str) -> String {
    format!("{operation}: Windows error {}", unsafe { GetLastError() })
}
struct OwnedHandle(Handle);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Registry(Handle);
impl Drop for Registry {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

fn open_key(root: Handle, path: &str) -> Result<Option<Registry>, String> {
    let mut result = null_mut();
    let code = unsafe { RegOpenKeyExW(root, wide(path).as_ptr(), 0, 0x20019 | 0x100, &mut result) };
    match code {
        0 => Ok(Some(Registry(result))),
        2 | 3 => Ok(None),
        _ => Err(format!(
            "Installation registry cannot be read: Windows error {code}"
        )),
    }
}
fn registry_string(key: &Registry, name: &str) -> Option<String> {
    let mut kind = 0;
    let mut bytes = 32768u32;
    let mut buffer = vec![0u16; 16384];
    let code = unsafe {
        RegQueryValueExW(
            key.0,
            wide(name).as_ptr(),
            null_mut(),
            &mut kind,
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if code != 0 || kind != 1 || bytes > 32768 || bytes % 2 != 0 {
        return None;
    }
    buffer.truncate(bytes as usize / 2);
    while buffer.last() == Some(&0) {
        buffer.pop();
    }
    String::from_utf16(&buffer).ok()
}

pub fn installation_roots() -> Result<Vec<PathBuf>, String> {
    let mut roots = Vec::new();
    for hive in [0x80000001u32, 0x80000002u32] {
        let hive = hive as i32 as isize as Handle;
        for branch in [
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
            "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ] {
            let Some(key) = open_key(hive, branch)? else {
                continue;
            };
            for index in 0..4096 {
                let mut name = vec![0u16; 512];
                let mut len = name.len() as u32;
                let code = unsafe {
                    RegEnumKeyExW(
                        key.0,
                        index,
                        name.as_mut_ptr(),
                        &mut len,
                        null_mut(),
                        null_mut(),
                        null_mut(),
                        null_mut(),
                    )
                };
                if code == 259 {
                    break;
                }
                if code != 0 {
                    return Err(format!(
                        "Installation registry enumeration failed: Windows error {code}"
                    ));
                }
                let Ok(name) = String::from_utf16(&name[..len as usize]) else {
                    continue;
                };
                let Some(entry) = open_key(key.0, &name)? else {
                    continue;
                };
                if registry_string(&entry, "DisplayName").as_deref() != Some("Rancher Desktop") {
                    continue;
                }
                if !registry_string(&entry, "Publisher")
                    .is_some_and(|p| p.to_ascii_lowercase().contains("suse"))
                {
                    continue;
                }
                let location = registry_string(&entry, "InstallLocation")
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
                    .or_else(|| {
                        registry_string(&entry, "DisplayIcon").and_then(|icon| {
                            let icon = icon.trim();
                            let path = if let Some(rest) = icon.strip_prefix('"') {
                                rest.split('"').next()?
                            } else {
                                icon.split(',').next()?
                            };
                            Path::new(path).parent().map(Path::to_path_buf)
                        })
                    });
                let Some(location) = location else {
                    continue;
                };
                if !location.join("Rancher Desktop.exe").is_file() {
                    continue;
                }
                if let Ok(root) = location.canonicalize() {
                    if !roots.contains(&root) {
                        roots.push(root);
                    }
                }
            }
        }
    }
    Ok(roots)
}

pub struct Pipe {
    handle: OwnedHandle,
    pub owner_path: String,
}
impl Pipe {
    pub fn connect(roots: &[PathBuf]) -> Result<Self, String> {
        let handle = unsafe {
            CreateFileW(
                wide(r"\\.\pipe\docker_engine").as_ptr(),
                0xc0000000,
                0,
                null(),
                3,
                0x40000000 | 0x00100000 | 0x00010000,
                null_mut(),
            )
        };
        if handle as isize == -1 {
            return Err(last_error("Docker named pipe unavailable"));
        }
        let handle = OwnedHandle(handle);
        let mut pid = 0;
        if unsafe { GetNamedPipeServerProcessId(handle.0, &mut pid) } == 0 {
            return Err(last_error("Pipe owner verification failed"));
        }
        let process = unsafe { OpenProcess(0x1000, 0, pid) };
        if process.is_null() {
            return Err(last_error("Pipe owner permission denied"));
        }
        let process = OwnedHandle(process);
        let mut buffer = vec![0u16; 32768];
        let mut len = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process.0, 0, buffer.as_mut_ptr(), &mut len) } == 0 {
            return Err(last_error("Pipe owner path unavailable"));
        }
        let owner = PathBuf::from(
            String::from_utf16(&buffer[..len as usize]).map_err(|_| "Invalid pipe owner path")?,
        );
        let canonical = owner
            .canonicalize()
            .map_err(|_| "Pipe owner executable cannot be verified")?;
        let expected = roots.iter().any(|root| {
            root.join("resources\\resources\\win32\\internal\\wsl-helper.exe")
                .canonicalize()
                .ok()
                .is_some_and(|path| {
                    path.to_string_lossy()
                        .eq_ignore_ascii_case(&canonical.to_string_lossy())
                })
        });
        if !expected {
            return Err(
                "Unsupported pipe owner: verified Rancher Desktop wsl-helper required".into(),
            );
        }
        Ok(Self {
            handle,
            owner_path: owner.to_string_lossy().into_owned(),
        })
    }

    fn transfer(&self, bytes: &mut [u8], write: bool, deadline: Instant) -> Result<usize, String> {
        let event = unsafe { CreateEventW(null(), 1, 0, null()) };
        if event.is_null() {
            return Err(last_error("Pipe event creation failed"));
        }
        let event = OwnedHandle(event);
        let mut operation = Overlapped {
            internal: 0,
            internal_high: 0,
            offset: 0,
            offset_high: 0,
            event: event.0,
        };
        let mut count = 0;
        let result = unsafe {
            if write {
                WriteFile(
                    self.handle.0,
                    bytes.as_ptr().cast(),
                    bytes.len() as u32,
                    &mut count,
                    &mut operation,
                )
            } else {
                ReadFile(
                    self.handle.0,
                    bytes.as_mut_ptr().cast(),
                    bytes.len() as u32,
                    &mut count,
                    &mut operation,
                )
            }
        };
        if result != 0 {
            return Ok(count as usize);
        }
        let error = unsafe { GetLastError() };
        if !write && [109, 232].contains(&error) {
            return Ok(0);
        }
        if error != 997 {
            return Err(format!("Named pipe I/O failed: Windows error {error}"));
        }
        let wait = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(u32::MAX as u128) as u32;
        let status = unsafe { WaitForSingleObject(event.0, wait) };
        if status != 0 {
            unsafe {
                CancelIoEx(self.handle.0, &mut operation);
                GetOverlappedResult(self.handle.0, &mut operation, &mut count, 1);
            }
            return Err("Docker request timed out; operation outcome may be unknown".into());
        }
        if unsafe { GetOverlappedResult(self.handle.0, &mut operation, &mut count, 0) } == 0 {
            let error = unsafe { GetLastError() };
            if !write && [109, 232].contains(&error) {
                return Ok(0);
            }
            return Err(format!("Named pipe I/O failed: Windows error {error}"));
        }
        Ok(count as usize)
    }

    pub fn request(
        &self,
        method: &str,
        path: &str,
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        if !["GET", "POST", "DELETE"].contains(&method)
            || !path.starts_with('/')
            || path.bytes().any(|b| b <= 32 || b >= 127)
        {
            return Err("Invalid internal Docker request".into());
        }
        let deadline = Instant::now() + timeout;
        let mut request = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\nUser-Agent: DockSlate/0.1\r\n\r\n").into_bytes();
        let mut offset = 0;
        while offset < request.len() {
            let count = self.transfer(&mut request[offset..], true, deadline)?;
            if count == 0 {
                return Err("Docker pipe closed during request".into());
            }
            offset += count;
        }
        let mut response = Vec::new();
        loop {
            if let Some(body) = parse_http(&response, false, limit)? {
                return Ok(body);
            }
            let mut buffer = [0u8; 16384];
            let count = self.transfer(&mut buffer, false, deadline)?;
            if count == 0 {
                return parse_http(&response, true, limit)?
                    .ok_or_else(|| "Incomplete Docker HTTP response".into());
            }
            if response.len().saturating_add(count) > limit + 65536 {
                return Err("Docker response exceeds safety limit".into());
            }
            response.extend_from_slice(&buffer[..count]);
        }
    }
}

fn parse_http(response: &[u8], closed: bool, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let Some(position) = response.windows(4).position(|s| s == b"\r\n\r\n") else {
        if response.len() > 32768 || closed {
            return Err("Invalid Docker HTTP headers".into());
        }
        return Ok(None);
    };
    if position > 32768 {
        return Err("Docker HTTP headers exceed safety limit".into());
    }
    let headers =
        std::str::from_utf8(&response[..position]).map_err(|_| "Invalid Docker HTTP headers")?;
    let mut lines = headers.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or("Invalid Docker HTTP status")?;
    let mut length = None;
    let mut chunked = false;
    for line in lines {
        let Some((key, value)) = line.split_once(':') else {
            return Err("Invalid Docker HTTP header".into());
        };
        if key.eq_ignore_ascii_case("content-length") {
            let parsed = value
                .trim()
                .parse::<usize>()
                .map_err(|_| "Invalid Docker response length")?;
            if length.is_some_and(|previous| previous != parsed) {
                return Err("Conflicting Docker response lengths".into());
            }
            length = Some(parsed);
        }
        if key.eq_ignore_ascii_case("transfer-encoding") {
            if !value.trim().eq_ignore_ascii_case("chunked") {
                return Err("Unsupported Docker transfer encoding".into());
            }
            chunked = true;
        }
    }
    if chunked && length.is_some() {
        return Err("Ambiguous Docker HTTP response framing".into());
    }
    let body = &response[position + 4..];
    let body = if status == 204 || status == 304 {
        Some(Vec::new())
    } else if chunked {
        decode_chunks(body, limit)?
    } else if let Some(length) = length {
        if length > limit {
            return Err("Docker response exceeds safety limit".into());
        }
        (body.len() >= length).then(|| body[..length].to_vec())
    } else if closed {
        if body.len() > limit {
            return Err("Docker response exceeds safety limit".into());
        }
        Some(body.to_vec())
    } else {
        None
    };
    let Some(body) = body else {
        return Ok(None);
    };
    if !(200..300).contains(&status) {
        let message = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["message"].as_str().map(str::to_owned))
            .unwrap_or_else(|| format!("Docker HTTP {status}"));
        return Err(format!(
            "Docker HTTP {status}: {}",
            message.chars().take(1000).collect::<String>()
        ));
    }
    Ok(Some(body))
}

fn decode_chunks(data: &[u8], limit: usize) -> Result<Option<Vec<u8>>, String> {
    let mut position = 0;
    let mut size_total = 0usize;
    let mut ranges = Vec::new();
    loop {
        let Some(end) = data[position..].windows(2).position(|s| s == b"\r\n") else {
            return Ok(None);
        };
        if end > 1024 {
            return Err("Invalid Docker chunk header".into());
        }
        let header = std::str::from_utf8(&data[position..position + end])
            .map_err(|_| "Invalid Docker chunk header")?;
        let size = usize::from_str_radix(header.split(';').next().unwrap_or(""), 16)
            .map_err(|_| "Invalid Docker chunk length")?;
        position += end + 2;
        if size == 0 {
            if data.len().saturating_sub(position) < 2 {
                return Ok(None);
            }
            if &data[position..position + 2] != b"\r\n" {
                let Some(trailer_end) = data[position..].windows(4).position(|s| s == b"\r\n\r\n")
                else {
                    return Ok(None);
                };
                if trailer_end > 32768 {
                    return Err("Docker HTTP trailers exceed safety limit".into());
                }
            }
            let mut body = Vec::with_capacity(size_total);
            for (start, end) in ranges {
                body.extend_from_slice(&data[start..end]);
            }
            return Ok(Some(body));
        }
        if size > limit.saturating_sub(size_total) {
            return Err("Docker response exceeds safety limit".into());
        }
        if data.len().saturating_sub(position) < size + 2 {
            return Ok(None);
        }
        size_total += size;
        ranges.push((position, position + size));
        if &data[position + size..position + size + 2] != b"\r\n" {
            return Err("Invalid Docker chunk framing".into());
        }
        position += size + 2;
    }
}
