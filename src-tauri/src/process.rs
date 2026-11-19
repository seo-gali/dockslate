#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::os::windows::io::{AsHandle, AsRawHandle};
use std::{
    io::{Read, Write},
    path::Path,
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

pub fn execute(
    program: &Path,
    args: &[String],
    stdin: Option<&[u8]>,
    timeout: Duration,
    max_output: usize,
) -> Result<Output, String> {
    execute_observed(program, args, stdin, timeout, max_output, None)
}

pub fn execute_observed(
    program: &Path,
    args: &[String],
    stdin: Option<&[u8]>,
    timeout: Duration,
    max_output: usize,
    on_stdout: Option<Box<dyn FnMut(&[u8]) + Send>>,
) -> Result<Output, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|error| format!("명령을 실행할 수 없습니다: {error}"))?;
    #[cfg(windows)]
    let (stdout_cancel, stderr_cancel, mut stdin_cancel) = {
        let handles = (|| -> std::io::Result<_> {
            let stdout = child.stdout.as_ref().ok_or_else(|| std::io::Error::other("stdout missing"))?.as_handle().try_clone_to_owned()?;
            let stderr = child.stderr.as_ref().ok_or_else(|| std::io::Error::other("stderr missing"))?.as_handle().try_clone_to_owned()?;
            let stdin = child.stdin.as_ref().map(|pipe| pipe.as_handle().try_clone_to_owned()).transpose()?;
            Ok((stdout, stderr, stdin))
        })();
        match handles {
            Ok(handles) => handles,
            Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(format!("명령 입출력 취소 연결 실패: {error}")); }
        }
    };
    let overflow = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    fn reader<R: Read + Send + 'static>(
        mut stream: R,
        limit: usize,
        flag: Arc<AtomicBool>,
        cancelled: Arc<AtomicBool>,
        mut observer: Option<Box<dyn FnMut(&[u8]) + Send>>,
    ) -> thread::JoinHandle<Vec<u8>> {
        thread::spawn(move || {
            let mut output = Vec::new();
            let mut buffer = [0u8; 8192];
            while !cancelled.load(Ordering::Acquire) {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let remaining = limit.saturating_sub(output.len());
                        output.extend_from_slice(&buffer[..count.min(remaining)]);
                        if let Some(observer) = observer.as_mut() {
                            observer(&buffer[..count.min(remaining)]);
                        }
                        if count > remaining {
                            flag.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                }
            }
            output
        })
    }
    let stdout = reader(
        child.stdout.take().ok_or("표준 출력 연결 실패")?,
        max_output,
        overflow.clone(),
        cancelled.clone(),
        on_stdout,
    );
    let stderr = reader(
        child.stderr.take().ok_or("표준 오류 연결 실패")?,
        max_output,
        overflow.clone(),
        cancelled.clone(),
        None,
    );
    let input = stdin.map(|bytes| bytes.to_vec());
    let input_writer = input.and_then(|bytes| {
        child.stdin.take().map(|mut pipe| {
            thread::spawn(move || {
                let _ = pipe.write_all(&bytes);
            })
        })
    });
    let started = Instant::now();
    let mut failure = None;
    let status = loop {
        #[cfg(windows)]
        if input_writer.as_ref().is_some_and(|writer| writer.is_finished()) { stdin_cancel.take(); }
        if overflow.load(Ordering::SeqCst) || started.elapsed() > timeout {
            failure = Some(if overflow.load(Ordering::SeqCst) {
                "명령 출력이 허용 크기를 초과했습니다"
            } else {
                "명령 응답 시간이 초과되었습니다"
            });
            let _ = child.kill();
            break child.wait().map_err(|error| error.to_string())?;
        }
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => break status,
            None => thread::sleep(Duration::from_millis(20)),
        }
    };
    // Drain within the same deadline; descendants may retain inherited pipe handles.
    while !stdout.is_finished() || !stderr.is_finished() || input_writer.as_ref().is_some_and(|writer| !writer.is_finished()) {
        if overflow.load(Ordering::Acquire) || started.elapsed() >= timeout {
            failure = Some(if overflow.load(Ordering::Acquire) {
                "명령 출력이 허용 크기를 초과했습니다"
            } else {
                "명령 응답 시간이 초과되었습니다"
            });
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    cancelled.store(true, Ordering::Release);
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CancelSynchronousIo(thread: *mut std::ffi::c_void) -> i32;
            fn CancelIoEx(file: *mut std::ffi::c_void, overlapped: *mut std::ffi::c_void) -> i32;
        }
        while !stdout.is_finished() || !stderr.is_finished() || input_writer.as_ref().is_some_and(|writer| !writer.is_finished()) {
            // Owned duplicates pin the file objects while their workers finish.
            for handle in [Some(stdout_cancel.as_raw_handle()), Some(stderr_cancel.as_raw_handle()), stdin_cancel.as_ref().map(AsRawHandle::as_raw_handle)].into_iter().flatten() {
                unsafe { CancelIoEx(handle, std::ptr::null_mut()); }
            }
            for handle in [Some(stdout.as_raw_handle()), Some(stderr.as_raw_handle()), input_writer.as_ref().map(AsRawHandle::as_raw_handle)].into_iter().flatten() {
                unsafe { CancelSynchronousIo(handle); }
            }
            thread::sleep(Duration::from_millis(2));
        }
    }
    if let Some(writer) = input_writer {
        let _ = writer.join();
    }
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if overflow.load(Ordering::Acquire) {
        return Err("명령 출력이 허용 크기를 초과했습니다".to_string());
    }
    if let Some(message) = failure {
        return Err(message.to_string());
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}
