use crate::docker::connected;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read},
    process::{ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use tauri::Emitter;

const EVENT: &str = "docker-engine-events";
static SESSION: OnceLock<Mutex<Option<Arc<Session>>>> = OnceLock::new();

// 원본 속성 대신 변경 종류만 전달하며 재연결 때 현재 목록으로 동기화
const FOLLOW: &str = r#"
import http.client, json, os, socket, sys, threading, time, urllib.parse

def cancel_on_eof():
    try:
        os.read(0, 1)
    finally:
        os._exit(0)

threading.Thread(target=cancel_on_eof, daemon=True).start()

class OwnedSocket(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect('/var/run/docker.sock')

def send(state, mask=0):
    print(json.dumps({'state': state, 'mask': mask}), flush=True)

actions = {
    'container': {'create', 'destroy', 'start', 'stop', 'die', 'kill', 'pause', 'unpause', 'rename', 'restart', 'update', 'health_status', 'prune'},
    'image': {'create', 'delete', 'import', 'load', 'pull', 'tag', 'untag', 'prune'},
    'volume': {'create', 'destroy', 'mount', 'unmount', 'prune'},
    'network': {'create', 'destroy', 'connect', 'disconnect', 'remove', 'prune'},
    'daemon': {'reload'},
}
filters = urllib.parse.quote(json.dumps({'type': list(actions)}))
masks = {'container': 1, 'image': 2, 'volume': 4, 'network': 8, 'daemon': 31}
while True:
    connection = None
    try:
        connection = OwnedSocket('localhost', timeout=10)
        connection.request('GET', '/v' + sys.argv[1] + '/info')
        response = connection.getresponse()
        info = response.read(65537)
        if response.status != 200 or len(info) > 65536 or json.loads(info).get('ID') != sys.argv[2]:
            raise RuntimeError('Engine identity changed')
        connection.close()
        connection = OwnedSocket('localhost', timeout=10)
        connection.request('GET', '/v' + sys.argv[1] + '/events?filters=' + filters)
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError('Events unavailable')
        connection.sock.settimeout(None)
        send('ready', 31)
        while True:
            line = response.readline(65537)
            if not line or len(line) > 65536:
                raise RuntimeError('Events disconnected')
            event = json.loads(line)
            kind = event.get('Type')
            action = str(event.get('Action', '')).split(':', 1)[0]
            if kind in actions and action in actions[kind]:
                send('changed', masks[kind])
    except Exception:
        send('reconnecting')
    finally:
        if connection is not None:
            connection.close()
    time.sleep(3)
"#;

struct Session {
    id: String,
    cancel: AtomicBool,
    finished: AtomicBool,
    input: Mutex<Option<ChildStdin>>,
}
fn session() -> &'static Mutex<Option<Arc<Session>>> { SESSION.get_or_init(|| Mutex::new(None)) }
fn valid_id(id: &str) -> bool { (16..=96).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)) }
fn cancel(value: &Session) {
    value.cancel.store(true, Ordering::Release);
    if let Ok(mut input) = value.input.lock() { input.take(); }
}
fn finish(value: &Arc<Session>) {
    if let Ok(mut current) = session().lock() {
        if current.as_ref().is_some_and(|current| Arc::ptr_eq(current, value)) { current.take(); }
    }
    value.finished.store(true, Ordering::Release);
}
fn wait(value: &Session) -> Result<(), String> {
    cancel(value);
    let deadline = Instant::now() + Duration::from_secs(2);
    while !value.finished.load(Ordering::Acquire) && Instant::now() < deadline { thread::sleep(Duration::from_millis(10)); }
    if value.finished.load(Ordering::Acquire) { Ok(()) } else { Err("Docker 변경 알림 연결을 종료하고 있습니다. 잠시 후 다시 시도하세요.".into()) }
}
pub fn close_all() -> Result<(), String> {
    let current = session().lock().map_err(|_| "Docker event subscription unavailable.")?.clone();
    if let Some(current) = current { wait(&current)?; }
    Ok(())
}
pub fn stop(stream_id: String) -> Result<Value, String> {
    if !valid_id(&stream_id) { return Err("Invalid Docker event subscription identifier.".into()); }
    let current = session().lock().map_err(|_| "Docker event subscription unavailable.")?.as_ref().filter(|value| value.id == stream_id).cloned();
    if let Some(current) = current { wait(&current)?; }
    Ok(json!({"stopped":true}))
}
fn emit(app: &tauri::AppHandle, session: &Session, state: &str, mask: u8) -> Result<(), String> {
    app.emit(EVENT, json!({"streamId":session.id,"state":state,"mask":mask})).map_err(|_| "Docker event delivery failed.".into())
}
pub fn start(app: tauri::AppHandle, stream_id: String, engine_id: String) -> Result<Value, String> {
    if !valid_id(&stream_id) || engine_id.is_empty() || engine_id.len() > 128 { return Err("Invalid Docker event subscription identity.".into()); }
    let client = connected()?;
    if client.identity != engine_id { return Err("Docker event engine identity changed. Refresh the connection.".into()); }
    close_all()?;
    let value = Arc::new(Session { id: stream_id, cancel: AtomicBool::new(false), finished: AtomicBool::new(false), input: Mutex::new(None) });
    {
        let mut current = session().lock().map_err(|_| "Docker event subscription unavailable.")?;
        if current.is_some() { return Err("The previous Docker event subscription is still closing.".into()); }
        *current = Some(value.clone());
    }
    let prepared = (|| {
        let mut input = value.input.lock().map_err(|_| "Docker event subscription unavailable.")?;
        if value.cancel.load(Ordering::Acquire) { return Err("Docker event subscription cancelled.".into()); }
        client.transport.verify_tool_start()?;
        let mut command = Command::new(crate::runtime::system_directory()?.join("wsl.exe"));
        command.args(["--distribution", "DockSlate", "--user", "root", "--exec", "/usr/bin/python3", "-I", "-u", "-c", FOLLOW, &client.api, &engine_id]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.spawn().map_err(|_| "Docker event stream could not start.")?;
        *input = child.stdin.take();
        Ok((client, child))
    })();
    let (client, mut child) = match prepared { Ok(prepared) => prepared, Err(error) => { finish(&value); return Err(error); } };
    let worker = value.clone();
    thread::spawn(move || {
        let (sender, receiver) = mpsc::sync_channel(8);
        let reader = child.stdout.take().map(|output| thread::spawn(move || {
            let mut output = BufReader::new(output);
            loop {
                let mut bytes = Vec::with_capacity(128);
                let result = (&mut output).take(1025).read_until(b'\n', &mut bytes);
                if !result.is_ok_and(|count| count > 0 && count <= 1024) { break; }
                let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { break };
                if sender.send(value).is_err() { break; }
            }
        }));
        let mut pending = 0u8;
        let mut flushed = Instant::now();
        let mut checked = Instant::now();
        while !worker.cancel.load(Ordering::Acquire) {
            match receiver.recv_timeout(Duration::from_millis(250)) {
                Ok(message) => {
                    let state = message["state"].as_str().unwrap_or("");
                    match state {
                        "ready" => { pending = 0; if emit(&app, &worker, "ready", 31).is_err() { break; } }
                        "changed" => { if let Some(mask) = message["mask"].as_u64().filter(|mask| (1..=31).contains(mask)) { pending |= mask as u8; } }
                        "reconnecting" => { pending = 0; if emit(&app, &worker, "reconnecting", 0).is_err() { break; } }
                        _ => break,
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if checked.elapsed() >= Duration::from_secs(1) {
                if client.transport.verify_tool_session().is_err() { break; }
                checked = Instant::now();
            }
            if pending != 0 && flushed.elapsed() >= Duration::from_millis(250) {
                if emit(&app, &worker, "changed", pending).is_err() { break; }
                pending = 0; flushed = Instant::now();
            }
        }
        drop(receiver);
        if let Ok(mut input) = worker.input.lock() { input.take(); }
        let deadline = Instant::now() + Duration::from_millis(500);
        while child.try_wait().is_ok_and(|exit| exit.is_none()) && Instant::now() < deadline { thread::sleep(Duration::from_millis(10)); }
        if !matches!(child.try_wait(), Ok(Some(_))) { let _ = child.kill(); }
        let _ = child.wait();
        if let Some(reader) = reader { let _ = reader.join(); }
        drop(client);
        if !worker.cancel.load(Ordering::Acquire) { let _ = emit(&app, &worker, "closed", 0); }
        finish(&worker);
    });
    Ok(json!({"streamId":value.id,"started":true}))
}
