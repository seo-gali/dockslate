#[path = "../src-tauri/src/process.rs"]
mod process;
use std::{env, fs, io::{self, Read, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, thread, time::{Duration, Instant}};

fn child(mode: &str, root: &Path) {
    match mode {
        "echo" => { let mut data=Vec::new();io::stdin().read_to_end(&mut data).unwrap();io::stdout().write_all(&data).unwrap();io::stderr().write_all(b"stderr").unwrap(); }
        "fail" => std::process::exit(7),
        "sleep" => thread::sleep(Duration::from_secs(10)),
        "overflow" => { let _=io::stdout().write_all(&vec![b'x';128*1024]); }
        "hold" => {thread::sleep(Duration::from_millis(2500));fs::write(root.join("finished"),b"alive").unwrap();}
        "spawn" | "spawn-exit" => {
            let mut child=Command::new(env::current_exe().unwrap());
            child.args(["hold",root.to_str().unwrap()]).stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
            #[cfg(windows)] { use std::os::windows::process::CommandExt;child.creation_flags(0x08000000); }
            let _descendant=child.spawn().unwrap();fs::write(root.join("ready"),b"started").unwrap();
            if mode=="spawn" {thread::sleep(Duration::from_secs(10));}
        }
        _ => panic!("Unknown owned fixture mode"),
    }
}
fn run(root:&Path,mode:&str,stdin:Option<&[u8]>,limit:usize,timeout:Duration)->(Result<std::process::Output,String>,u128) {
    let started=Instant::now();
    let result=process::execute(&env::current_exe().unwrap(),&[mode.into(),root.to_str().unwrap().into()],stdin,timeout,limit);
    (result,started.elapsed().as_millis())
}
fn main() {
    let args:Vec<_>=env::args().collect();
    if args.len()==3 {child(&args[1],&PathBuf::from(&args[2]));return;}
    assert_eq!(args.len(),2,"Provide the owned project fixture directory");
    let root=fs::canonicalize(&args[1]).unwrap();
    assert_eq!(root.parent().unwrap().file_name().unwrap(),".analysis");
    assert!(root.file_name().unwrap().to_str().unwrap().starts_with("process-check-"));
    let body=vec![b'a';16*1024];
    let (normal,_)=run(&root,"echo",Some(&body),32*1024,Duration::from_secs(3));let normal=normal.unwrap();
    assert!(normal.status.success());assert_eq!(normal.stdout,body);assert_eq!(normal.stderr,b"stderr");
    let (failed,_)=run(&root,"fail",None,4096,Duration::from_secs(3));assert_eq!(failed.unwrap().status.code(),Some(7));
    let (overflow,overflow_ms)=run(&root,"overflow",None,128,Duration::from_secs(3));assert!(overflow.is_err());assert!(overflow_ms<1750);
    let (timeout,timeout_ms)=run(&root,"sleep",None,4096,Duration::from_millis(200));assert!(timeout.is_err());assert!(timeout_ms<950);
    let input=vec![b'i';4*1024*1024];let (blocked,blocked_ms)=run(&root,"sleep",Some(&input),4096,Duration::from_millis(200));assert!(blocked.is_err());assert!(blocked_ms<950);
    let mut elapsed=Vec::new();
    for mode in ["spawn","spawn-exit"] {
        let ready=root.join("ready");let finished=root.join("finished");let _=fs::remove_file(&ready);let _=fs::remove_file(&finished);
        let (result,ms)=run(&root,mode,None,4096,Duration::from_secs(1));assert!(result.is_err());assert!(ready.exists());assert!(ms<1750,"Inherited pipe exceeded deadline: {ms}");
        let until=Instant::now()+Duration::from_secs(4);while !finished.exists(){assert!(Instant::now()<until,"Owned descendant was terminated");thread::sleep(Duration::from_millis(10));}
        elapsed.push(ms);
    }
    println!("{{\"checks\":7,\"passed\":true,\"timeoutMs\":{timeout_ms},\"blockedInputMs\":{blocked_ms},\"inheritedPipeMs\":{:?},\"persistentDescendantsPreserved\":true,\"engineChanged\":false}}",elapsed);
}
