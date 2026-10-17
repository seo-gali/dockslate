use std::{env, ffi::c_void, path::PathBuf, ptr};
type Hwnd = *mut c_void;
#[link(name="user32")]
unsafe extern "system" {
    fn EnumWindows(callback: unsafe extern "system" fn(Hwnd,isize)->i32, data:isize)->i32;
    fn EnumChildWindows(hwnd:Hwnd, callback: unsafe extern "system" fn(Hwnd,isize)->i32, data:isize)->i32;
    fn GetWindowThreadProcessId(hwnd:Hwnd,pid:*mut u32)->u32;
    fn GetClassNameW(hwnd:Hwnd,text:*mut u16,max:i32)->i32;
    fn GetWindowTextW(hwnd:Hwnd,text:*mut u16,max:i32)->i32;
    fn GetDlgCtrlID(hwnd:Hwnd)->i32;
    fn GetParent(hwnd:Hwnd)->Hwnd;
    fn GetDlgItem(hwnd:Hwnd,id:i32)->Hwnd;
    fn SendMessageTimeoutW(hwnd:Hwnd,msg:u32,wparam:usize,lparam:isize,flags:u32,timeout:u32,result:*mut usize)->isize;
    fn PostMessageW(hwnd:Hwnd,msg:u32,wparam:usize,lparam:isize)->i32;
    fn IsWindowVisible(hwnd:Hwnd)->i32;
}
#[link(name="kernel32")]
unsafe extern "system" {
    fn OpenProcess(access:u32,inherit:i32,pid:u32)->*mut c_void;
    fn QueryFullProcessImageNameW(process:*mut c_void,flags:u32,name:*mut u16,size:*mut u32)->i32;
    fn CloseHandle(handle:*mut c_void)->i32;
}
struct State { pid:u32, dialogs:Vec<Hwnd>, edits:Vec<Hwnd>, inspect:bool, described:usize, controls:usize }
fn class(hwnd:Hwnd)->String { let mut text=[0u16;128]; let count=unsafe{GetClassNameW(hwnd,text.as_mut_ptr(),128)};String::from_utf16_lossy(&text[..count.max(0) as usize]) }
fn title(hwnd:Hwnd)->String {let mut text=[0u16;512];let count=unsafe{GetWindowTextW(hwnd,text.as_mut_ptr(),512)};String::from_utf16_lossy(&text[..count.max(0) as usize])}
fn control_text(hwnd:Hwnd)->String {let mut text=[0u16;1024];let mut result=0;let ok=unsafe{SendMessageTimeoutW(hwnd,0x000d,text.len(),text.as_mut_ptr() as isize,0x23,200,&mut result)};if ok==0{return "<text unavailable>".into();}String::from_utf16_lossy(&text[..result.min(1023)])}
fn own(hwnd:Hwnd,pid:u32)->bool {let mut actual=0;unsafe{GetWindowThreadProcessId(hwnd,&mut actual)};!hwnd.is_null()&&actual==pid}
unsafe extern "system" fn window(hwnd:Hwnd,data:isize)->i32 {
    let state=unsafe{&mut *(data as *mut State)};let mut pid=0;unsafe{GetWindowThreadProcessId(hwnd,&mut pid)};
    if pid==state.pid && class(hwnd)=="#32770" && unsafe{IsWindowVisible(hwnd)}!=0 {state.dialogs.push(hwnd);} 1
}
unsafe extern "system" fn child(hwnd:Hwnd,data:isize)->i32 {
    let state=unsafe{&mut *(data as *mut State)};let kind=class(hwnd);let id=unsafe{GetDlgCtrlID(hwnd)};
    if !own(hwnd,state.pid){return 1;}
    state.controls+=1;
    if state.inspect&&state.controls<=80 {println!("child class={kind:?} id={id} hwnd={:x}",hwnd as usize);}
    if state.inspect&&kind=="Static"&&state.described<40 {println!("static id={id} text={:?}",control_text(hwnd));state.described+=1;}
    if kind=="Edit" {let parent=unsafe{GetParent(hwnd)};let parent_id=unsafe{GetDlgCtrlID(parent)};let grand_id=unsafe{GetDlgCtrlID(GetParent(parent))};
        if state.inspect{println!("edit id={id} parent={parent_id} grand={grand_id}");}
        let classic=[id,parent_id,grand_id].contains(&1148);
        let modern=id==1001&&parent_id==0&&own(parent,state.pid)&&class(parent)=="ComboBox"&&grand_id==0&&own(unsafe{GetParent(parent)},state.pid)&&class(unsafe{GetParent(parent)})=="FloatNotifySink";
        if classic||modern {if state.inspect {println!("filename text={:?}",control_text(hwnd));}state.edits.push(hwnd);}}
    1
}
fn main() {
    let args:Vec<_>=env::args().collect();assert!((args.len()==3&&["inspect","cancel"].contains(&args[1].as_str()))||(args.len()==4&&args[1]=="select"),"inspect PID or select PID FILE or cancel PID");
    let pid:u32=args[2].parse().expect("pid");let root=env::current_dir().unwrap().canonicalize().unwrap();
    let expected=root.join("src-tauri/target/release/dockslate.exe").canonicalize().unwrap();
    let handle=unsafe{OpenProcess(0x1000,0,pid)};assert!(!handle.is_null(),"app unavailable");
    let mut name=vec![0u16;32768];let mut length=name.len() as u32;
    assert_ne!(unsafe{QueryFullProcessImageNameW(handle,0,name.as_mut_ptr(),&mut length)},0);unsafe{CloseHandle(handle)};
    assert_eq!(PathBuf::from(String::from_utf16_lossy(&name[..length as usize])).canonicalize().unwrap(),expected,"only built workspace app allowed");
    let mut state=State{pid,dialogs:vec![],edits:vec![],inspect:args[1]=="inspect",described:0,controls:0};
    for _ in 0..100 {state.dialogs.clear();unsafe{EnumWindows(window,&mut state as *mut _ as isize)};if !state.dialogs.is_empty(){break;}std::thread::sleep(std::time::Duration::from_millis(100));}
    if state.inspect {println!("own dialogs={}",state.dialogs.len());for dialog in state.dialogs.clone(){state.edits.clear();state.described=0;state.controls=0;println!("dialog hwnd={:x} title={:?}",dialog as usize,title(dialog));for id in [1,2]{let button=unsafe{GetDlgItem(dialog,id)};println!("dialog button id={id} own={} class={:?} hwnd={:x}",own(button,pid),class(button),button as usize);}unsafe{EnumChildWindows(dialog,child,&mut state as *mut _ as isize)};println!("matching filename edits={} own child controls={}",state.edits.len(),state.controls);}return;}
    let mut eligible=Vec::new();
    for _ in 0..100 {eligible.clear();state.dialogs.clear();unsafe{EnumWindows(window,&mut state as *mut _ as isize)};
        for dialog in state.dialogs.clone(){state.edits.clear();state.controls=0;unsafe{EnumChildWindows(dialog,child,&mut state as *mut _ as isize)};
            let ok=unsafe{GetDlgItem(dialog,1)};let cancel=unsafe{GetDlgItem(dialog,2)};
            let known=matches!(title(dialog).as_str(),"볼륨에 가져올 tar 파일 선택"|"볼륨 내보내기 파일 선택"|"빌드 기록을 저장할 새 파일 선택"|"가져올 빌드 기록 선택");
            if known&&state.edits.len()==1&&own(ok,pid)&&class(ok)=="Button"&&own(cancel,pid)&&class(cancel)=="Button"{eligible.push((dialog,state.edits[0]));}}
        if eligible.len()==1{break;}std::thread::sleep(std::time::Duration::from_millis(100));}
    assert_eq!(eligible.len(),1,"exactly one own filename picker required");let(dialog,edit)=eligible[0];
    if args[1]=="cancel" {let button=unsafe{GetDlgItem(dialog,2)};assert!(own(button,pid)&&class(button)=="Button");assert_ne!(unsafe{PostMessageW(button,0x00f5,0,0)},0);println!("posted scoped picker cancellation");return;}
    let filename=PathBuf::from(&args[3]);assert!(filename.is_absolute());let parent=filename.parent().unwrap().canonicalize().unwrap();
    assert!(parent.starts_with(&root)&&parent!=root,"fixtures must stay below workspace");
    if filename.exists(){assert!(filename.canonicalize().unwrap().starts_with(&root));}
    let text:Vec<u16>=filename.to_str().unwrap().encode_utf16().chain(Some(0)).collect();
    assert!(text.len()<=1024,"fixture filename exceeds bounded readback");
    let mut result=0;assert_ne!(unsafe{SendMessageTimeoutW(edit,0x000c,0,text.as_ptr() as isize,0x23,2000,&mut result)},0,"filename edit timed out");assert_ne!(result,0,"filename edit rejected text");
    assert_eq!(control_text(edit),filename.to_str().unwrap(),"filename readback mismatch");
    let ok=unsafe{GetDlgItem(dialog,1)};assert_ne!(ok,ptr::null_mut());
    assert!(own(ok,pid)&&class(ok)=="Button");assert_ne!(unsafe{PostMessageW(ok,0x00f5,0,0)},0);println!("posted scoped fixture selection; caller must await actual picker result");
}
