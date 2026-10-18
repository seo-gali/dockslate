use crate::docker::{connected, Client};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Emitter;

const EVENT: &str = "container-log-stream";
const MAX_SESSIONS: usize = 4;
const MAX_PENDING: usize = 128 * 1024;
const MAX_EVENT: usize = 32 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_millis(75);
static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();

// 고정 소켓의 읽기 전용 스트림과 표준 입력 종료 감지
const FOLLOW: &str = r#"
import http.client, os, socket, sys, threading

def cancel_on_eof():
    try:
        os.read(0, 1)
    finally:
        os._exit(0)

threading.Thread(target=cancel_on_eof, daemon=True).start()

class OwnedSocket(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(15)
        self.sock.connect('/var/run/docker.sock')

try:
    connection = OwnedSocket('localhost', timeout=15)
    connection.request('GET', '/v' + sys.argv[1] + '/containers/' + sys.argv[2] + '/logs?stdout=1&stderr=1&timestamps=1&tail=300&follow=1')
    connection.sock.settimeout(None)
    response = connection.getresponse()
    if response.status != 200:
        os.write(2, ('Docker log stream HTTP ' + str(response.status)).encode('ascii'))
        os._exit(3)
    sys.stdout.buffer.write(b'DSLOGS1\n')
    sys.stdout.buffer.flush()
    while True:
        data = response.read1(8192)
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    connection.close()
    os._exit(0)
except Exception:
    os.write(2, b'The owned Docker log stream disconnected.')
    os._exit(4)
"#;

struct Session {
    cancel: AtomicBool,
    finished: AtomicBool,
    input: Mutex<Option<ChildStdin>>,
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn valid_container(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_stream(id: &str) -> bool {
    (16..=96).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

fn remove(stream_id: &str, session: &Arc<Session>) {
    if let Ok(mut active) = sessions().lock() {
        if active
            .get(stream_id)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            active.remove(stream_id);
        }
    }
}

fn cancel(session: &Session) {
    session.cancel.store(true, Ordering::Release);
    if let Ok(mut input) = session.input.lock() {
        input.take();
    }
}

pub fn start(app: tauri::AppHandle, id: String, stream_id: String) -> Result<Value, String> {
    if !valid_container(&id) || !valid_stream(&stream_id) {
        return Err("Invalid container log stream identifier.".into());
    }
    let session = Arc::new(Session {
        cancel: AtomicBool::new(false),
        finished: AtomicBool::new(false),
        input: Mutex::new(None),
    });
    {
        let mut active = sessions().lock().map_err(|_| "Log streams unavailable.")?;
        if active.contains_key(&stream_id) || active.len() >= MAX_SESSIONS {
            return Err("Close the previous container log stream before opening another.".into());
        }
        active.insert(stream_id.clone(), session.clone());
    }
    let prepared = (|| {
        let client = connected()?;
        if session.cancel.load(Ordering::Acquire) {
            return Err("Container log stream was cancelled.".to_owned());
        }
        let inspect = client.json("GET", &format!("/containers/{id}/json?size=false"))?;
        if inspect["Id"].as_str() != Some(&id) {
            return Err("Container log stream identity changed.".to_owned());
        }
        let tty = inspect["Config"]["Tty"]
            .as_bool()
            .ok_or("Container log format unavailable.")?;
        if !client
            .api
            .strip_prefix("1.")
            .and_then(|value| value.parse::<u32>().ok())
            .is_some_and(|minor| (41..=55).contains(&minor))
        {
            return Err("Unsupported Docker log stream API.".to_owned());
        }
        let mut input = session
            .input
            .lock()
            .map_err(|_| "Log stream unavailable.")?;
        if session.cancel.load(Ordering::Acquire) {
            return Err("Container log stream was cancelled.".to_owned());
        }
        let mut command = Command::new(crate::runtime::system_directory()?.join("wsl.exe"));
        command
            .args([
                "--distribution",
                "DockSlate",
                "--user",
                "root",
                "--exec",
                "/usr/bin/python3",
                "-I",
                "-u",
                "-c",
                FOLLOW,
                &client.api,
                &id,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "The owned container log stream could not start.")?;
        *input = child.stdin.take();
        Ok((client, child, tty))
    })();
    match prepared {
        Err(error) => {
            session.finished.store(true, Ordering::Release);
            remove(&stream_id, &session);
            Err(error)
        }
        Ok((client, child, tty)) => {
            let worker_session = session.clone();
            let worker_id = id.clone();
            let worker_stream = stream_id.clone();
            thread::spawn(move || {
                follow(
                    &app,
                    &worker_id,
                    &worker_stream,
                    child,
                    tty,
                    &worker_session,
                    client,
                );
                worker_session.finished.store(true, Ordering::Release);
                remove(&worker_stream, &worker_session);
            });
            Ok(json!({"streamId":stream_id,"id":id,"started":true}))
        }
    }
}

pub fn stop(stream_id: String) -> Result<Value, String> {
    if !valid_stream(&stream_id) {
        return Err("Invalid container log stream identifier.".into());
    }
    let session = sessions()
        .lock()
        .map_err(|_| "Log streams unavailable.")?
        .get(&stream_id)
        .cloned();
    if let Some(session) = session {
        cancel(&session);
    }
    Ok(json!({"streamId":stream_id,"stopped":true}))
}

pub fn close_all() {
    let active: Vec<_> = sessions()
        .lock()
        .map(|active| active.values().cloned().collect())
        .unwrap_or_default();
    for session in &active {
        cancel(session);
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while active
        .iter()
        .any(|session| !session.finished.load(Ordering::Acquire))
        && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(20));
    }
}

enum Message {
    Ready,
    Data(Vec<u8>),
    End(Result<(), String>),
}

fn output(mut output: impl Read, sender: mpsc::SyncSender<Message>) {
    let mut handshake = [0u8; 8];
    if output.read_exact(&mut handshake).is_err() || &handshake != b"DSLOGS1\n" {
        let _ = sender.send(Message::End(Err(
            "The owned Docker log stream could not connect.".into(),
        )));
        return;
    }
    if sender.send(Message::Ready).is_err() {
        return;
    }
    let mut bytes = [0u8; 8192];
    loop {
        match output.read(&mut bytes) {
            Ok(0) => {
                let _ = sender.send(Message::End(Ok(())));
                return;
            }
            Ok(count) => {
                if sender.send(Message::Data(bytes[..count].to_vec())).is_err() {
                    return;
                }
            }
            Err(_) => {
                let _ = sender.send(Message::End(Err(
                    "The owned Docker log stream disconnected.".into(),
                )));
                return;
            }
        }
    }
}

#[derive(Default)]
struct Utf8 {
    pending: Vec<u8>,
}
impl Utf8 {
    fn push(&mut self, bytes: &[u8], content: &mut String) {
        self.pending.extend_from_slice(bytes);
        let mut position = 0;
        while position < self.pending.len() {
            match std::str::from_utf8(&self.pending[position..]) {
                Ok(valid) => {
                    content.push_str(valid);
                    position = self.pending.len();
                }
                Err(error) => {
                    let end = position + error.valid_up_to();
                    content.push_str(
                        std::str::from_utf8(&self.pending[position..end]).unwrap_or_default(),
                    );
                    position = end;
                    if let Some(count) = error.error_len() {
                        content.push('\u{fffd}');
                        position += count;
                    } else {
                        break;
                    }
                }
            }
        }
        self.pending.drain(..position);
    }
    fn finish(&mut self, content: &mut String) {
        if !self.pending.is_empty() {
            content.push_str(&String::from_utf8_lossy(&self.pending));
            self.pending.clear();
        }
    }
}

struct Frames {
    tty: bool,
    header: Vec<u8>,
    remaining: usize,
    stream: usize,
    utf8: [Utf8; 3],
}
impl Frames {
    fn new(tty: bool) -> Self {
        Self {
            tty,
            header: Vec::with_capacity(8),
            remaining: 0,
            stream: 0,
            utf8: Default::default(),
        }
    }
    fn push(&mut self, mut bytes: &[u8], content: &mut String) -> Result<(), String> {
        if self.tty {
            self.utf8[0].push(bytes, content);
            return Ok(());
        }
        while !bytes.is_empty() {
            if self.remaining == 0 {
                let count = (8 - self.header.len()).min(bytes.len());
                self.header.extend_from_slice(&bytes[..count]);
                bytes = &bytes[count..];
                if self.header.len() < 8 {
                    continue;
                }
                if self.header[0] > 2 || self.header[1..4] != [0, 0, 0] {
                    return Err("Invalid Docker log stream framing.".into());
                }
                self.stream = self.header[0] as usize;
                self.remaining = u32::from_be_bytes(self.header[4..8].try_into().unwrap()) as usize;
                self.header.clear();
                if self.remaining > 16 * 1024 * 1024 {
                    return Err("Docker log frame exceeds its safety limit.".into());
                }
            }
            let count = self.remaining.min(bytes.len());
            self.utf8[self.stream].push(&bytes[..count], content);
            self.remaining -= count;
            bytes = &bytes[count..];
        }
        Ok(())
    }
    fn finish(&mut self, content: &mut String) -> Result<(), String> {
        if !self.header.is_empty() || self.remaining != 0 {
            return Err("Incomplete Docker log stream frame.".into());
        }
        for decoder in &mut self.utf8 {
            decoder.finish(content);
        }
        Ok(())
    }
}

struct Events<'a> {
    app: &'a tauri::AppHandle,
    id: &'a str,
    stream_id: &'a str,
    sequence: u64,
    pending: String,
    truncated: bool,
    last: Instant,
}
impl Events<'_> {
    fn send(
        &mut self,
        state: &str,
        content: String,
        reset: bool,
        message: Option<&str>,
    ) -> Result<(), String> {
        let payload = json!({"streamId":self.stream_id,"id":self.id,"state":state,"content":content,"reset":reset,"truncated":self.truncated,"sequence":self.sequence,"message":message});
        self.app
            .emit(EVENT, payload)
            .map_err(|_| "Container log event delivery failed.")?;
        self.sequence += 1;
        self.truncated = false;
        self.last = Instant::now();
        Ok(())
    }
    fn bound(&mut self) {
        if self.pending.len() > MAX_PENDING {
            let mut remove = self.pending.len() - MAX_PENDING;
            while !self.pending.is_char_boundary(remove) {
                remove += 1;
            }
            self.pending.drain(..remove);
            self.truncated = true;
        }
    }
    fn flush(&mut self) -> Result<(), String> {
        if !self.pending.is_empty() {
            let mut end = self.pending.len().min(MAX_EVENT);
            while !self.pending.is_char_boundary(end) {
                end -= 1;
            }
            let content = self.pending.drain(..end).collect();
            self.send("streaming", content, false, None)?;
        }
        Ok(())
    }
}

fn read_stream(
    receiver: &Receiver<Message>,
    session: &Session,
    tty: bool,
    events: &mut Events<'_>,
) -> Result<(), String> {
    let started = Instant::now();
    let mut ready = false;
    let mut frames = Frames::new(tty);
    loop {
        if session.cancel.load(Ordering::Acquire) {
            return Ok(());
        }
        if !ready && started.elapsed() > Duration::from_secs(30) {
            return Err("The owned Docker log stream did not connect in time.".into());
        }
        match receiver.recv_timeout(Duration::from_millis(25)) {
            Ok(Message::Ready) => {
                ready = true;
                events.send("streaming", String::new(), true, None)?;
            }
            Ok(Message::Data(bytes)) => {
                frames.push(&bytes, &mut events.pending)?;
                events.bound();
            }
            Ok(Message::End(result)) => {
                result?;
                frames.finish(&mut events.pending)?;
                while !events.pending.is_empty() {
                    events.flush()?;
                }
                return Ok(());
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err("The owned Docker log stream disconnected.".into())
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        if ready && events.last.elapsed() >= FLUSH_INTERVAL {
            events.flush()?;
        }
    }
}

fn follow(
    app: &tauri::AppHandle,
    id: &str,
    stream_id: &str,
    mut child: Child,
    tty: bool,
    session: &Session,
    client: Client,
) {
    let (sender, receiver) = mpsc::sync_channel(8);
    let stdout = child
        .stdout
        .take()
        .map(|stdout| thread::spawn(move || output(stdout, sender)));
    let stderr = child.stderr.take().map(|mut stderr| {
        thread::spawn(move || {
            let mut bytes = [0u8; 2048];
            while stderr.read(&mut bytes).is_ok_and(|count| count > 0) {}
        })
    });
    let mut events = Events {
        app,
        id,
        stream_id,
        sequence: 0,
        pending: String::new(),
        truncated: false,
        last: Instant::now(),
    };
    let mut outcome = if stdout.is_some() {
        read_stream(&receiver, session, tty, &mut events)
    } else {
        Err("The owned Docker log stream output is unavailable.".into())
    };
    drop(receiver);
    if let Ok(mut input) = session.input.lock() {
        input.take();
    }
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut exited = false;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => {
                exited = true;
                if !status.success() && outcome.is_ok() {
                    outcome = Err("The owned Docker log stream ended unexpectedly.".into());
                }
                break;
            }
            Err(_) => break,
            Ok(None) => thread::sleep(Duration::from_millis(10)),
        }
    }
    if !exited {
        let _ = child.kill();
        let _ = child.wait();
    }
    for reader in [stdout, stderr].into_iter().flatten() {
        if reader.is_finished() {
            let _ = reader.join();
        }
    }
    drop(client);
    if !session.cancel.load(Ordering::Acquire) {
        let _ = match outcome {
            Ok(()) => events.send("closed", String::new(), false, None),
            Err(error) => events.send("error", String::new(), false, Some(&error)),
        };
    }
}
