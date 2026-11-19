use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const LIMIT: u64 = 64 * 1024;
static WRITE: Mutex<()> = Mutex::new(());

fn plain_directory(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.access_mode(0x80).share_mode(3).custom_flags(0x02000000 | 0x00200000);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
    }
    if !metadata.is_dir() { return Err(io::ErrorKind::InvalidInput.into()); }
    Ok(file)
}

fn append(root: &Path, status: u16) -> io::Result<()> {
    if !root.is_absolute() { return Err(io::ErrorKind::InvalidInput.into()); }
    let mut guards = Vec::new();
    for ancestor in root.ancestors() { guards.push(plain_directory(ancestor)?); }
    let directory = root.join("DockSlate");
    match fs::create_dir(&directory) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error),
    }
    guards.push(plain_directory(&directory)?);
    let mut options = OpenOptions::new();
    options.write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x00200000);
    }
    let mut file = options.open(directory.join("security.jsonl"))?;
    let metadata = file.metadata()?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
    }
    if !metadata.is_file() { return Err(io::ErrorKind::InvalidInput.into()); }
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let line = format!("{{\"time\":{timestamp},\"event\":\"pipe_request_rejected\",\"status\":{status}}}\n");
    // shortcut: Retains the latest 64 KiB; export the log for longer incident history.
    if metadata.len() + line.len() as u64 > LIMIT { file.set_len(0)?; }
    else { use std::io::{Seek, SeekFrom}; file.seek(SeekFrom::End(0))?; }
    file.write_all(line.as_bytes())
}

pub(crate) fn rejected_pipe_request(status: u16) {
    if !matches!(status, 400 | 501) { return; }
    let Ok(_guard) = WRITE.lock() else { return; };
    let result = std::env::var_os("LOCALAPPDATA").ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
        .and_then(|root| append(Path::new(&root), status));
    if result.is_err() { eprintln!("DockSlate: security event could not be saved."); }
}

#[cfg(test)]
mod security_tests {
    use super::*;
    #[test]
    fn rejection_log_contains_only_metadata_and_stays_bounded() {
        let directory = std::env::current_dir().unwrap().join("target").join(format!("security-log-test-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        let result = (|| -> io::Result<()> {
            append(&directory,400)?;
            let file = directory.join("DockSlate/security.jsonl");
            let value: serde_json::Value = serde_json::from_str(fs::read_to_string(&file)?.trim())?;
            assert_eq!(value.as_object().unwrap().len(),3);
            assert_eq!(value["event"],"pipe_request_rejected");
            assert_eq!(value["status"],400);
            fs::write(&file, vec![b'x'; LIMIT as usize])?;
            append(&directory,501)?;
            assert!(fs::metadata(&file)?.len() < 256);
            assert!(append(Path::new("relative"),400).is_err());
            Ok(())
        })();
        fs::remove_dir_all(&directory).unwrap();
        result.unwrap();
    }
}
