#[cfg(windows)]
mod windows {
    use crate::{
        cli_platform::native::{self, Handle, RawHandle},
        runtime::Transport,
    };
    use serde_json::Value;
    use std::{
        ffi::c_void,
        io::{self, BufRead, BufReader, Read, Write},
        ptr::{null, null_mut},
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc, Mutex,
        },
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };

    const HEADER_LIMIT: usize = 65536;
    const JSON_LIMIT: usize = 16 * 1024 * 1024;
    const IDLE: Duration = Duration::from_secs(90);
    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: RawHandle,
    }
    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: RawHandle,
        inherit: i32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateNamedPipeW(
            name: *const u16,
            access: u32,
            mode: u32,
            instances: u32,
            output: u32,
            input: u32,
            timeout: u32,
            security: *const SecurityAttributes,
        ) -> RawHandle;
        fn ConnectNamedPipe(pipe: RawHandle, overlapped: *mut Overlapped) -> i32;
        fn ReadFile(
            handle: RawHandle,
            data: *mut c_void,
            len: u32,
            read: *mut u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        fn WriteFile(
            handle: RawHandle,
            data: *const c_void,
            len: u32,
            written: *mut u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        fn CreateEventW(
            security: *const c_void,
            manual: i32,
            initial: i32,
            name: *const u16,
        ) -> RawHandle;
        fn GetOverlappedResult(
            handle: RawHandle,
            overlapped: *mut Overlapped,
            transferred: *mut u32,
            wait: i32,
        ) -> i32;
        fn WaitForSingleObject(handle: RawHandle, timeout: u32) -> u32;
        fn CancelIoEx(handle: RawHandle, overlapped: *mut Overlapped) -> i32;
        fn CancelSynchronousIo(thread: RawHandle) -> i32;
        fn OpenThread(access: u32, inherit: i32, id: u32) -> RawHandle;
        fn GetCurrentThreadId() -> u32;
        fn GetLastError() -> u32;
        fn PeekNamedPipe(
            pipe: RawHandle,
            buffer: *mut c_void,
            size: u32,
            read: *mut u32,
            available: *mut u32,
            remaining: *mut u32,
        ) -> i32;
        fn LocalFree(memory: RawHandle) -> RawHandle;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string: *const u16,
            revision: u32,
            descriptor: *mut RawHandle,
            size: *mut u32,
        ) -> i32;
    }
    struct Descriptor(RawHandle);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    fn descriptor() -> Result<Descriptor, String> {
        let sddl = native::wide(&format!("D:P(A;;GA;;;{})", native::current_sid()?));
        let mut descriptor = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(native::error(
                "Cannot restrict the Docker pipe to the current user",
            ));
        }
        Ok(Descriptor(descriptor))
    }
    fn listener(first: bool, security: &Descriptor) -> Result<Handle, String> {
        let attributes = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: security.0,
            inherit: 0,
        };
        let raw = unsafe {
            CreateNamedPipeW(
                native::wide(&native::pipe_name()?).as_ptr(),
                3 | 0x40000000 | if first { 0x00080000 } else { 0 },
                0x8 | 0x4,
                32,
                65536,
                65536,
                0,
                &attributes,
            )
        };
        if raw as isize == -1 {
            return Err(native::error("Cannot own the private DockSlate pipe"));
        }
        Ok(Handle(raw as isize))
    }
    fn event() -> io::Result<Handle> {
        let handle = unsafe { CreateEventW(null(), 1, 0, null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Handle(handle as isize))
    }
    fn operation(event: &Handle) -> Overlapped {
        Overlapped {
            internal: 0,
            internal_high: 0,
            offset: 0,
            offset_high: 0,
            event: event.raw(),
        }
    }
    fn cancel_operation(handle: &Handle, operation: &mut Overlapped) {
        let mut count = 0;
        unsafe {
            CancelIoEx(handle.raw(), operation);
            GetOverlappedResult(handle.raw(), operation, &mut count, 1);
        }
    }
    fn accept(
        pipe: &Handle,
        workers: &mut Vec<JoinHandle<()>>,
        idle: &mut Instant,
    ) -> Result<bool, String> {
        let event = event().map_err(|e| e.to_string())?;
        let mut op = operation(&event);
        if unsafe { ConnectNamedPipe(pipe.raw(), &mut op) } != 0 {
            return Ok(true);
        }
        match unsafe { GetLastError() } {
            535 => return Ok(true),
            997 => {}
            _ => return Err(native::error("Cannot accept a DockSlate pipe connection")),
        }
        loop {
            workers.retain_mut(|worker| !worker.is_finished());
            if !workers.is_empty() {
                *idle = Instant::now();
            }
            if workers.is_empty() && idle.elapsed() >= IDLE {
                cancel_operation(pipe, &mut op);
                return Ok(false);
            }
            match unsafe { WaitForSingleObject(event.raw(), 200) } {
                0 => {
                    let mut count = 0;
                    if unsafe { GetOverlappedResult(pipe.raw(), &mut op, &mut count, 0) } == 0 {
                        return Err(native::error("The DockSlate pipe connection failed"));
                    }
                    return Ok(true);
                }
                258 => {}
                _ => {
                    cancel_operation(pipe, &mut op);
                    return Err(native::error("Cannot wait for the DockSlate pipe"));
                }
            }
        }
    }
    struct Connection {
        handle: Handle,
        cancelled: Arc<AtomicBool>,
    }
    impl Connection {
        fn cancel(&self) {
            self.cancelled.store(true, Ordering::Release);
            unsafe {
                CancelIoEx(self.handle.raw(), null_mut());
            }
        }
    }
    #[derive(Clone)]
    struct Stream {
        connection: Arc<Connection>,
        deadline: Option<Instant>,
    }
    impl Stream {
        fn transfer(&self, bytes: &mut [u8], write: bool) -> io::Result<usize> {
            if bytes.is_empty() {
                return Ok(0);
            }
            if self.connection.cancelled.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "Docker connection cancelled",
                ));
            }
            let event = event()?;
            let deadline = self
                .deadline
                .or_else(|| write.then(|| Instant::now() + Duration::from_secs(30)));
            let mut op = operation(&event);
            let mut count = 0;
            let length = bytes.len().min(u32::MAX as usize) as u32;
            let success = unsafe {
                if write {
                    WriteFile(
                        self.connection.handle.raw(),
                        bytes.as_ptr().cast(),
                        length,
                        &mut count,
                        &mut op,
                    )
                } else {
                    ReadFile(
                        self.connection.handle.raw(),
                        bytes.as_mut_ptr().cast(),
                        length,
                        &mut count,
                        &mut op,
                    )
                }
            };
            if success != 0 {
                return Ok(count as usize);
            }
            let code = unsafe { GetLastError() };
            if !write && matches!(code, 109 | 232 | 233) {
                return Ok(0);
            }
            if code != 997 {
                return Err(io::Error::from_raw_os_error(code as i32));
            }
            loop {
                if self.connection.cancelled.load(Ordering::Acquire)
                    || deadline.is_some_and(|deadline| Instant::now() >= deadline)
                {
                    cancel_operation(&self.connection.handle, &mut op);
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Docker pipe operation cancelled or timed out",
                    ));
                }
                match unsafe { WaitForSingleObject(event.raw(), 100) } {
                    0 => {
                        if unsafe {
                            GetOverlappedResult(
                                self.connection.handle.raw(),
                                &mut op,
                                &mut count,
                                0,
                            )
                        } != 0
                        {
                            return Ok(count as usize);
                        }
                        let code = unsafe { GetLastError() };
                        if !write && matches!(code, 109 | 232 | 233) {
                            return Ok(0);
                        }
                        return Err(io::Error::from_raw_os_error(code as i32));
                    }
                    258 => {}
                    _ => {
                        cancel_operation(&self.connection.handle, &mut op);
                        return Err(io::Error::last_os_error());
                    }
                }
            }
        }
    }
    impl Read for Stream {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            self.transfer(bytes, false)
        }
    }
    impl Write for Stream {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let mut bounded = [0u8; 16384];
            let count = bytes.len().min(bounded.len());
            bounded[..count].copy_from_slice(&bytes[..count]);
            self.transfer(&mut bounded[..count], true)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    struct GuestReader<R> {
        inner: R,
        cancelled: Arc<AtomicBool>,
    }
    impl<R: Read> Read for GuestReader<R> {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            if self.cancelled.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "Docker connection cancelled",
                ));
            }
            self.inner.read(bytes)
        }
    }
    type Failure = (u16, String);
    fn bad(message: &str) -> Failure {
        (400, message.into())
    }
    fn io_failure(error: io::Error) -> Failure {
        (400, format!("Docker stream failed: {error}"))
    }
    fn bounded_line(reader: &mut impl BufRead, limit: usize) -> Result<Vec<u8>, Failure> {
        let mut line = Vec::new();
        loop {
            let available = reader.fill_buf().map_err(io_failure)?;
            if available.is_empty() {
                return if line.is_empty() {
                    Ok(line)
                } else {
                    Err(bad("Incomplete Docker HTTP line"))
                };
            }
            let count = available
                .iter()
                .position(|b| *b == b'\n')
                .map_or(available.len(), |i| i + 1);
            if line.len().saturating_add(count) > limit {
                return Err(bad("Docker HTTP headers exceed 64 KiB"));
            }
            line.extend_from_slice(&available[..count]);
            reader.consume(count);
            if line.ends_with(b"\n") {
                if !line.ends_with(b"\r\n") {
                    return Err(bad("Docker HTTP requires CRLF framing"));
                }
                return Ok(line);
            }
        }
    }
    #[derive(Clone, Copy)]
    enum Framing {
        None,
        Length(u64),
        Chunked,
    }
    struct Headers {
        first: String,
        fields: Vec<(String, String)>,
        framing: Framing,
    }
    fn token(value: &str) -> bool {
        !value.is_empty()
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
    }
    impl Headers {
        fn read(reader: &mut impl BufRead) -> Result<Option<Self>, Failure> {
            let first = bounded_line(reader, HEADER_LIMIT)?;
            if first.is_empty() {
                return Ok(None);
            }
            let mut size = first.len();
            let first = std::str::from_utf8(&first[..first.len() - 2])
                .map_err(|_| bad("Invalid Docker HTTP request line"))?
                .to_owned();
            let mut fields = Vec::new();
            let mut length = None;
            let mut chunked = false;
            loop {
                let line = bounded_line(reader, HEADER_LIMIT.saturating_sub(size))?;
                size += line.len();
                if line == b"\r\n" {
                    break;
                }
                if line.is_empty() {
                    return Err(bad("Incomplete Docker HTTP headers"));
                }
                let line = std::str::from_utf8(&line[..line.len() - 2])
                    .map_err(|_| bad("Invalid Docker HTTP header encoding"))?;
                let (key, value) = line
                    .split_once(':')
                    .ok_or_else(|| bad("Invalid Docker HTTP header"))?;
                if !token(key) || value.bytes().any(|b| b < 32 && b != b'\t' || b == 127) {
                    return Err(bad("Invalid Docker HTTP header"));
                }
                let value = value.trim();
                if key.eq_ignore_ascii_case("content-length") {
                    if length.is_some()
                        || value.is_empty()
                        || !value.bytes().all(|b| b.is_ascii_digit())
                    {
                        return Err(bad("Duplicate or invalid Docker Content-Length"));
                    }
                    length = Some(
                        value
                            .parse::<u64>()
                            .map_err(|_| bad("Invalid Docker Content-Length"))?,
                    );
                }
                if key.eq_ignore_ascii_case("transfer-encoding") {
                    if chunked || !value.eq_ignore_ascii_case("chunked") {
                        return Err((
                            501,
                            "Only chunked Docker Transfer-Encoding is supported".into(),
                        ));
                    }
                    chunked = true;
                }
                fields.push((key.to_owned(), value.to_owned()));
            }
            if length.is_some() && chunked {
                return Err(bad("Conflicting Docker HTTP body framing"));
            }
            Ok(Some(Self {
                first,
                fields,
                framing: if chunked {
                    Framing::Chunked
                } else if let Some(length) = length {
                    Framing::Length(length)
                } else {
                    Framing::None
                },
            }))
        }
        fn field(&self, name: &str) -> Option<&str> {
            self.fields
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        }
        fn connection_token(&self, name: &str) -> bool {
            self.fields
                .iter()
                .filter(|(key, _)| key.eq_ignore_ascii_case("connection"))
                .any(|(_, value)| {
                    value
                        .split(',')
                        .any(|value| value.trim().eq_ignore_ascii_case(name))
                })
        }
        fn write(&self, writer: &mut impl Write) -> Result<(), Failure> {
            writer
                .write_all(self.first.as_bytes())
                .map_err(io_failure)?;
            writer.write_all(b"\r\n").map_err(io_failure)?;
            for (key, value) in &self.fields {
                writer
                    .write_all(format!("{key}: {value}\r\n").as_bytes())
                    .map_err(io_failure)?;
            }
            writer.write_all(b"\r\n").map_err(io_failure)
        }
    }
    fn copy_length(
        reader: &mut impl Read,
        writer: &mut impl Write,
        mut length: u64,
    ) -> Result<(), Failure> {
        let mut bytes = [0u8; 16384];
        while length != 0 {
            let take = (length.min(bytes.len() as u64)) as usize;
            let count = reader.read(&mut bytes[..take]).map_err(io_failure)?;
            if count == 0 {
                return Err(bad("Incomplete Docker HTTP body"));
            }
            writer.write_all(&bytes[..count]).map_err(io_failure)?;
            length -= count as u64;
        }
        Ok(())
    }
    fn chunks(
        reader: &mut impl BufRead,
        writer: &mut impl Write,
        decoded: bool,
        limit: Option<usize>,
    ) -> Result<(), Failure> {
        let mut total = 0u64;
        loop {
            let line = bounded_line(reader, 1024)?;
            if line.is_empty() {
                return Err(bad("Incomplete Docker chunk header"));
            }
            let header = std::str::from_utf8(&line[..line.len() - 2])
                .map_err(|_| bad("Invalid Docker chunk header"))?;
            if header.bytes().any(|byte| byte < 32 || byte == 127) {
                return Err(bad("Invalid Docker chunk extension"));
            }
            let size = header.split(';').next().unwrap_or("");
            if size.is_empty() || !size.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(bad("Invalid Docker chunk length"));
            }
            let size =
                u64::from_str_radix(size, 16).map_err(|_| bad("Invalid Docker chunk length"))?;
            total = total
                .checked_add(size)
                .ok_or_else(|| bad("Docker body length overflow"))?;
            if limit.is_some_and(|limit| total > limit as u64) {
                return Err(bad("Container create body exceeds 16 MiB"));
            }
            if !decoded {
                writer.write_all(&line).map_err(io_failure)?;
            }
            if size == 0 {
                let mut trailer_size = 0;
                loop {
                    let trailer = bounded_line(reader, HEADER_LIMIT.saturating_sub(trailer_size))?;
                    if trailer.is_empty() {
                        return Err(bad("Incomplete Docker HTTP trailers"));
                    }
                    trailer_size += trailer.len();
                    if trailer != b"\r\n" {
                        if decoded {
                            return Err((501, "Container create trailers are unsupported".into()));
                        }
                        let value = std::str::from_utf8(&trailer[..trailer.len() - 2])
                            .map_err(|_| bad("Invalid Docker HTTP trailer"))?;
                        let (key, value) = value
                            .split_once(':')
                            .ok_or_else(|| bad("Invalid Docker HTTP trailer"))?;
                        if !token(key)
                            || value.bytes().any(|b| b < 32 && b != b'\t' || b == 127)
                            || key.eq_ignore_ascii_case("content-length")
                            || key.eq_ignore_ascii_case("transfer-encoding")
                        {
                            return Err(bad("Invalid Docker HTTP trailer"));
                        }
                    }
                    if !decoded {
                        writer.write_all(&trailer).map_err(io_failure)?;
                    }
                    if trailer == b"\r\n" {
                        return Ok(());
                    }
                }
            }
            copy_length(reader, writer, size)?;
            let mut end = [0u8; 2];
            reader.read_exact(&mut end).map_err(io_failure)?;
            if end != *b"\r\n" {
                return Err(bad("Invalid Docker chunk boundary"));
            }
            if !decoded {
                writer.write_all(&end).map_err(io_failure)?;
            }
        }
    }
    fn stream_body(
        reader: &mut impl BufRead,
        writer: &mut impl Write,
        framing: Framing,
    ) -> Result<(), Failure> {
        match framing {
            Framing::None => Ok(()),
            Framing::Length(length) => copy_length(reader, writer, length),
            Framing::Chunked => chunks(reader, writer, false, None),
        }
    }
    fn guest_source(
        source: &str,
        transport: &Transport,
        named_volume: bool,
    ) -> Result<String, Failure> {
        if source.starts_with("\\\\") || source.starts_with("//") || source.starts_with('\\') {
            return Err(bad("UNC and ambiguous Windows bind paths are unsupported"));
        }
        if source.starts_with('/') {
            return Ok(source.into());
        }
        let bytes = source.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            if bytes.len() < 3
                || !matches!(bytes[2], b'/' | b'\\')
                || source[2..].contains(':')
                || source.chars().any(char::is_control)
            {
                return Err(bad("Bind sources require an absolute Windows drive path"));
            }
            return transport
                .build_path(source)
                .map_err(|message| (400, message));
        }
        if named_volume
            && source
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            && source
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
        {
            return Ok(source.into());
        }
        Err(bad(
            "Bind sources require an absolute Windows drive path or guest path",
        ))
    }
    fn rewrite_create(body: &[u8], transport: &Transport) -> Result<Vec<u8>, Failure> {
        let mut value: Value =
            serde_json::from_slice(body).map_err(|_| bad("Invalid container create JSON"))?;
        if !value.is_object() {
            return Err(bad("Container create JSON must be an object"));
        }
        if let Some(config) = value.get_mut("HostConfig").filter(|value| !value.is_null()) {
            if !config.is_object() {
                return Err(bad("HostConfig must be an object"));
            }
            if let Some(binds) = config.get_mut("Binds").filter(|value| !value.is_null()) {
                let binds = binds
                    .as_array_mut()
                    .ok_or_else(|| bad("HostConfig.Binds must be an array"))?;
                for bind in binds {
                    let text = bind
                        .as_str()
                        .ok_or_else(|| bad("Each bind must be a string"))?;
                    let bytes = text.as_bytes();
                    let drive =
                        bytes.len() > 1 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
                    let windows_separator = drive
                        .then(|| text[2..].find(':').map(|index| index + 2))
                        .flatten()
                        .filter(|index| text[index + 1..].starts_with('/'));
                    let offset = if windows_separator.is_some() { 2 } else { 0 };
                    let delimiter = text[offset..]
                        .find(':')
                        .map(|index| offset + index)
                        .ok_or_else(|| bad("Each bind must contain a source and target"))?;
                    let source = guest_source(&text[..delimiter], transport, true)?;
                    *bind = Value::String(format!("{source}{}", &text[delimiter..]));
                }
            }
            if let Some(mounts) = config.get_mut("Mounts").filter(|value| !value.is_null()) {
                let mounts = mounts
                    .as_array_mut()
                    .ok_or_else(|| bad("HostConfig.Mounts must be an array"))?;
                for mount in mounts {
                    if mount.get("Type").and_then(Value::as_str) != Some("bind") {
                        continue;
                    }
                    let source = mount
                        .get("Source")
                        .and_then(Value::as_str)
                        .ok_or_else(|| bad("A bind mount requires Source"))?;
                    let source = guest_source(source, transport, false)?;
                    mount["Source"] = Value::String(source);
                }
            }
        }
        let body =
            serde_json::to_vec(&value).map_err(|_| bad("Cannot encode container create JSON"))?;
        if body.len() > JSON_LIMIT {
            return Err(bad("Converted container create body exceeds 16 MiB"));
        }
        Ok(body)
    }
    fn create_path(path: &str) -> bool {
        let path = path.split('?').next().unwrap_or(path);
        if path == "/containers/create" {
            return true;
        }
        let Some(rest) = path.strip_prefix("/v1.") else {
            return false;
        };
        let Some((minor, rest)) = rest.split_once('/') else {
            return false;
        };
        !minor.is_empty()
            && minor.bytes().all(|b| b.is_ascii_digit())
            && rest == "containers/create"
    }
    fn docker_error(writer: &mut Stream, status: u16, message: &str) {
        writer.deadline = Some(Instant::now() + Duration::from_secs(5));
        let body = serde_json::json!({"message":message}).to_string();
        let reason = if status == 501 {
            "Not Implemented"
        } else if status == 503 {
            "Service Unavailable"
        } else {
            "Bad Request"
        };
        let _ = write!(writer, "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    }
    enum Reply {
        Next,
        Upgrade,
        Close,
    }
    struct Request {
        head: bool,
        upgrade: bool,
        close: bool,
    }
    fn requests(
        mut reader: BufReader<Stream>,
        mut first: Headers,
        mut output: impl Write,
        transport: Transport,
        metadata: mpsc::SyncSender<Request>,
        replies: mpsc::Receiver<Reply>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(), Failure> {
        loop {
            let parts: Vec<&str> = first.first.split(' ').collect();
            if parts.len() != 3
                || !token(parts[0])
                || !["HTTP/1.1", "HTTP/1.0"].contains(&parts[2])
                || !parts[1].starts_with('/')
                || parts[1].bytes().any(|b| b <= 32 || b >= 127 || b == b'#')
            {
                return Err(bad("Unsupported Docker HTTP request line"));
            }
            let method = parts[0].to_owned();
            let create = method == "POST" && create_path(parts[1]);
            let close = parts[2] == "HTTP/1.0" || first.connection_token("close");
            let upgrade = first.connection_token("upgrade") && first.field("upgrade").is_some();
            if first.field("upgrade").is_some() && !upgrade {
                return Err(bad("Invalid Docker HTTP upgrade"));
            }
            if first.fields.iter().any(|(key, value)| {
                key.eq_ignore_ascii_case("expect") && !value.eq_ignore_ascii_case("100-continue")
            }) {
                return Err((501, "Only Expect: 100-continue is supported".into()));
            }
            if matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS") {
                transport
                    .verify_tool_session()
                    .map_err(|message| (503, message))?;
            } else {
                transport
                    .verify_tool_start()
                    .map_err(|message| (503, message))?;
            }
            if first.field("expect").is_some() {
                let mut client = reader.get_ref().clone();
                client.deadline = Some(Instant::now() + Duration::from_secs(30));
                client
                    .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
                    .map_err(io_failure)?;
                first
                    .fields
                    .retain(|(key, _)| !key.eq_ignore_ascii_case("expect"));
            }
            let converted = if create {
                let mut body = Vec::new();
                match first.framing {
                    Framing::Length(length) => {
                        if length > JSON_LIMIT as u64 {
                            return Err(bad("Container create body exceeds 16 MiB"));
                        }
                        copy_length(&mut reader, &mut body, length)?;
                    }
                    Framing::Chunked => {
                        if first.field("trailer").is_some() {
                            return Err((501, "Container create trailers are unsupported".into()));
                        }
                        chunks(&mut reader, &mut body, true, Some(JSON_LIMIT))?;
                    }
                    Framing::None => {
                        return Err(bad("Container create requires a framed JSON body"))
                    }
                }
                let body = rewrite_create(&body, &transport)?;
                first.fields.retain(|(key, _)| {
                    !key.eq_ignore_ascii_case("content-length")
                        && !key.eq_ignore_ascii_case("transfer-encoding")
                });
                first
                    .fields
                    .push(("Content-Length".into(), body.len().to_string()));
                Some(body)
            } else {
                None
            };
            metadata
                .send(Request {
                    head: method == "HEAD",
                    upgrade,
                    close,
                })
                .map_err(|_| bad("Docker response stream closed"))?;
            first.write(&mut output)?;
            if let Some(body) = converted {
                output.write_all(&body).map_err(io_failure)?;
            } else {
                stream_body(&mut reader, &mut output, first.framing)?;
            }
            output.flush().map_err(io_failure)?;
            let reply = loop {
                if cancelled.load(Ordering::Acquire) {
                    return Ok(());
                }
                match replies.recv_timeout(Duration::from_millis(100)) {
                    Ok(reply) => break reply,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => return Ok(()),
                }
            };
            match reply {
                Reply::Upgrade => {
                    io::copy(&mut reader, &mut output).map_err(io_failure)?;
                    return Ok(());
                }
                Reply::Close => return Ok(()),
                Reply::Next => {}
            }
            reader.get_mut().deadline = Some(Instant::now() + Duration::from_secs(30));
            let headers = Headers::read(&mut reader)?;
            reader.get_mut().deadline = None;
            let Some(headers) = headers else {
                return Ok(());
            };
            first = headers;
        }
    }
    fn responses(
        mut input: impl BufRead,
        mut output: Stream,
        requests: mpsc::Receiver<Request>,
        replies: mpsc::SyncSender<Reply>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(), Failure> {
        loop {
            let request = loop {
                if cancelled.load(Ordering::Acquire) {
                    return Ok(());
                }
                match requests.recv_timeout(Duration::from_millis(100)) {
                    Ok(request) => break request,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => return Ok(()),
                }
            };
            loop {
                let headers = Headers::read(&mut input)?
                    .ok_or_else(|| bad("Docker daemon closed its response"))?;
                let parts: Vec<&str> = headers.first.split(' ').collect();
                let status = parts
                    .get(1)
                    .and_then(|status| status.parse::<u16>().ok())
                    .filter(|status| (100..=599).contains(status))
                    .ok_or_else(|| bad("Invalid Docker HTTP response"))?;
                headers.write(&mut output)?;
                if status == 101 {
                    if !request.upgrade || !headers.connection_token("upgrade") {
                        return Err(bad("Unexpected Docker protocol upgrade"));
                    }
                    replies
                        .send(Reply::Upgrade)
                        .map_err(|_| bad("Docker request stream closed"))?;
                    io::copy(&mut input, &mut output).map_err(io_failure)?;
                    return Ok(());
                }
                if status == 200
                    && request.upgrade
                    && headers.field("content-type").is_some_and(|value| {
                        matches!(
                            value.split(';').next().unwrap_or("").trim(),
                            "application/vnd.docker.raw-stream"
                                | "application/vnd.docker.multiplexed-stream"
                        )
                    })
                {
                    replies
                        .send(Reply::Upgrade)
                        .map_err(|_| bad("Docker request stream closed"))?;
                    io::copy(&mut input, &mut output).map_err(io_failure)?;
                    return Ok(());
                }
                if status < 200 {
                    continue;
                }
                if !request.head && status != 204 && status != 304 {
                    if matches!(headers.framing, Framing::None) {
                        io::copy(&mut input, &mut output).map_err(io_failure)?;
                        let _ = replies.send(Reply::Close);
                        return Ok(());
                    }
                    stream_body(&mut input, &mut output, headers.framing)?;
                }
                let close = request.close
                    || headers.connection_token("close")
                    || headers.first.starts_with("HTTP/1.0 ");
                replies
                    .send(if close { Reply::Close } else { Reply::Next })
                    .map_err(|_| bad("Docker request stream closed"))?;
                if close {
                    return Ok(());
                }
                break;
            }
        }
    }
    fn register_thread(handles: &Mutex<Vec<Handle>>) -> Result<(), ()> {
        let raw = unsafe { OpenThread(1, 0, GetCurrentThreadId()) };
        if raw.is_null() {
            return Err(());
        }
        if let Ok(mut handles) = handles.lock() {
            handles.push(Handle(raw as isize));
            Ok(())
        } else {
            unsafe {
                native::CloseHandle(raw);
            }
            Err(())
        }
    }
    fn cancel_threads(handles: &Mutex<Vec<Handle>>) {
        if let Ok(handles) = handles.lock() {
            for handle in handles.iter() {
                unsafe {
                    CancelSynchronousIo(handle.raw());
                }
            }
        }
    }
    fn session(line: &[u8]) -> Option<(u32, u64)> {
        let text = std::str::from_utf8(line)
            .ok()?
            .trim_end_matches(['\r', '\n']);
        let (pid, started) = text
            .strip_prefix("DOCKSLATE_PROXY_SESSION:")?
            .split_once(':')?;
        let pid = pid.parse::<u32>().ok()?;
        let started = started.parse::<u64>().ok()?;
        (pid > 1 && started != 0).then_some((pid, started))
    }
    fn connection(handle: Handle) {
        let cancelled = Arc::new(AtomicBool::new(false));
        let connection = Arc::new(Connection {
            handle,
            cancelled: cancelled.clone(),
        });
        let stream = Stream {
            connection: connection.clone(),
            deadline: None,
        };
        let mut reader = BufReader::with_capacity(
            16384,
            Stream {
                deadline: Some(Instant::now() + Duration::from_secs(30)),
                ..stream.clone()
            },
        );
        let first = match Headers::read(&mut reader) {
            Ok(Some(first)) => first,
            Ok(None) => return,
            Err((code, message)) => {
                docker_error(&mut stream.clone(), code, &message);
                return;
            }
        };
        reader.get_mut().deadline = None;
        let client = match crate::docker::connected() {
            Ok(client) => client,
            Err(message) => {
                docker_error(&mut stream.clone(), 503, &message);
                return;
            }
        };
        let transport = client.transport;
        let mut child = match transport.spawn_dial_stdio() {
            Ok(child) => child,
            Err(message) => {
                docker_error(&mut stream.clone(), 503, &message);
                return;
            }
        };
        let Some(stderr) = child.stderr.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return;
        };
        let handles = Arc::new(Mutex::new(Vec::new()));
        let (session_tx, session_rx) = mpsc::sync_channel(1);
        let stderr_handles = handles.clone();
        let stderr_cancelled = cancelled.clone();
        let errors = thread::spawn(move || {
            if register_thread(&stderr_handles).is_err() {
                let _ = session_tx.send(None);
                return;
            }
            let mut stderr = BufReader::with_capacity(
                4096,
                GuestReader {
                    inner: stderr,
                    cancelled: stderr_cancelled,
                },
            );
            let mut line = Vec::with_capacity(256);
            while line.len() < 256 {
                let mut byte = [0u8; 1];
                if stderr.read_exact(&mut byte).is_err() {
                    break;
                }
                line.push(byte[0]);
                if byte[0] == b'\n' {
                    break;
                }
            }
            let _ = session_tx.send(session(&line));
            let mut bytes = [0u8; 4096];
            while let Ok(count) = stderr.read(&mut bytes) {
                if count == 0 {
                    break;
                }
            }
        });
        let guest = session_rx
            .recv_timeout(Duration::from_secs(10))
            .ok()
            .flatten();
        let Some((pid, started)) = guest else {
            docker_error(
                &mut stream.clone(),
                503,
                "The owned Docker proxy guest session could not be verified",
            );
            let _ = child.kill();
            let _ = child.wait();
            while !errors.is_finished() {
                cancel_threads(&handles);
                thread::sleep(Duration::from_millis(20));
            }
            let _ = errors.join();
            return;
        };
        let Some(stdin) = child.stdin.take() else {
            let _ = transport.cancel_dial_stdio(pid, started);
            return;
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = transport.cancel_dial_stdio(pid, started);
            return;
        };
        let (request_tx, request_rx) = mpsc::sync_channel(1);
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        let input_transport = transport.clone();
        let input_cancelled = cancelled.clone();
        let input_stream = stream.clone();
        let input_handles = handles.clone();
        let input = thread::spawn(move || {
            if register_thread(&input_handles).is_err() {
                return;
            }
            if let Err((code, message)) = requests(
                reader,
                first,
                stdin,
                input_transport,
                request_tx,
                reply_rx,
                input_cancelled,
            ) {
                docker_error(&mut input_stream.clone(), code, &message);
            }
        });
        let output_cancelled = cancelled.clone();
        let output_handles = handles.clone();
        let output_stream = stream.clone();
        let output = thread::spawn(move || {
            if register_thread(&output_handles).is_err() {
                return;
            }
            let _ = responses(
                BufReader::with_capacity(
                    16384,
                    GuestReader {
                        inner: stdout,
                        cancelled: output_cancelled.clone(),
                    },
                ),
                output_stream,
                request_rx,
                reply_tx,
                output_cancelled,
            );
        });
        let mut verified = Instant::now();
        loop {
            if output.is_finished() {
                break;
            }
            if verified.elapsed() >= Duration::from_secs(1) {
                let connected = unsafe {
                    PeekNamedPipe(
                        connection.handle.raw(),
                        null_mut(),
                        0,
                        null_mut(),
                        null_mut(),
                        null_mut(),
                    )
                } != 0;
                if !connected || transport.verify_tool_session().is_err() {
                    break;
                }
                verified = Instant::now();
            }
            thread::sleep(Duration::from_millis(50));
        }
        connection.cancel();
        cancel_threads(&handles);
        let _ = transport.cancel_dial_stdio(pid, started);
        let _ = child.kill();
        let _ = child.wait();
        while !input.is_finished() || !output.is_finished() || !errors.is_finished() {
            cancel_threads(&handles);
            thread::sleep(Duration::from_millis(20));
        }
        let _ = input.join();
        let _ = output.join();
        let _ = errors.join();
    }
    pub(crate) fn serve() -> Result<(), String> {
        let security = descriptor()?;
        let mut listener_pipe = listener(true, &security)?;
        let mut workers = Vec::new();
        let mut idle = Instant::now();
        loop {
            workers.retain_mut(|worker: &mut JoinHandle<()>| !worker.is_finished());
            if workers.len() >= 31 {
                thread::sleep(Duration::from_millis(100));
                continue;
            }
            if !accept(&listener_pipe, &mut workers, &mut idle)? {
                return Ok(());
            }
            idle = Instant::now();
            // Keep one instance owned while replacing the listener.
            let next = listener(false, &security)?;
            let accepted = std::mem::replace(&mut listener_pipe, next);
            workers.push(thread::spawn(move || connection(accepted)));
        }
    }
}

pub(crate) fn serve() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::serve()
    }
    #[cfg(not(windows))]
    {
        Err("The DockSlate pipe broker requires Windows 11".into())
    }
}
