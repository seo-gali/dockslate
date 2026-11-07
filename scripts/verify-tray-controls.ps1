param([Parameter(Mandatory=$true)][string]$SessionFile, [ValidateSet('status','hide','left','menu','open','settings','containers','images','refresh','quit')][string]$Action='status')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
using System;using System.Runtime.InteropServices;using System.Text;
public static class TrayNativeCheck {
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc c,IntPtr d);
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder t,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr h,StringBuilder t,int n);
 [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("kernel32.dll")]public static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("user32.dll")]public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")]public static extern int GetMenuItemCount(IntPtr menu);
 [DllImport("user32.dll")]public static extern uint GetMenuItemID(IntPtr menu,int pos);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetMenuString(IntPtr menu,uint pos,StringBuilder text,int count,uint flags);
 [DllImport("shell32.dll")]static extern int Shell_NotifyIconGetRect(ref IconId id,out Rect rect);
 [StructLayout(LayoutKind.Sequential)]struct IconId {public uint size;public IntPtr hwnd;public uint id;public Guid guid;}
 [StructLayout(LayoutKind.Sequential)]struct Rect {public int left,top,right,bottom;}
 public static uint RegisteredId(IntPtr hwnd) {uint found=0;for(uint n=1;n<=16;n++){var id=new IconId{size=(uint)Marshal.SizeOf(typeof(IconId)),hwnd=hwnd,id=n};Rect rect;if(Shell_NotifyIconGetRect(ref id,out rect)==0){if(found!=0)throw new Exception("Ambiguous owned icon.");found=n;}}return found;}
 public static IntPtr Window(int pid,string matchClass) {IntPtr found=IntPtr.Zero;EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(p!=pid)return true;var t=new StringBuilder(256);if(matchClass==null){GetWindowText(h,t,256);if(t.ToString()!="DockSlate")return true;}else{GetClassName(h,t,256);if(t.ToString()!=matchClass||(matchClass=="#32768"&&!IsWindowVisible(h)))return true;}found=h;return false;},IntPtr.Zero);return found;}
}
'@
$analysisRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.analysis'))+[IO.Path]::DirectorySeparatorChar
$sessionPath=[IO.Path]::GetFullPath($SessionFile)
if(!$sessionPath.StartsWith($analysisRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Only a project-local verification session is allowed.'}
$session=Get-Content -LiteralPath $sessionPath -Raw -Encoding UTF8|ConvertFrom-Json
$fixturePath=[IO.Path]::GetFullPath($session.artifact)
if(!$fixturePath.StartsWith($analysisRoot,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($fixturePath) -cne 'dockslate.exe' -or [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($fixturePath)) -notmatch '^tray-native-[a-f0-9]{32}$'){throw 'A disposable tray verification executable is required.'}
$process=Get-Process -Id $session.pid -ErrorAction Stop
$processHandle=$process.Handle
if($process.StartTime.ToUniversalTime().Ticks.ToString() -cne $session.startedTicks -or $process.Path -cne $session.artifact -or (Get-FileHash -LiteralPath $process.Path).Hash -cne $session.sha256){throw 'Verification process identity differs.'}
$window=[TrayNativeCheck]::Window($process.Id,$null)
if($window -eq [IntPtr]::Zero){$window=$process.MainWindowHandle}
if($window -eq [IntPtr]::Zero){throw 'Candidate window not found.'}
$trayWindow=[TrayNativeCheck]::Window($process.Id,'tray_icon_app')
if($trayWindow -eq [IntPtr]::Zero){throw 'Owned tray-icon window not found.'}
$trayId=[TrayNativeCheck]::RegisteredId($trayWindow)
if(!$trayId){throw 'Candidate tray icon is not registered with Windows Shell.'}
if($Action -eq 'status'){@{alive=$true;visible=[TrayNativeCheck]::IsWindowVisible($window);shellIconRegistered=$true}|ConvertTo-Json;exit}
if($Action -eq 'hide'){[void][TrayNativeCheck]::PostMessage($window,0x10,[IntPtr]::Zero,[IntPtr]::Zero);Start-Sleep -Milliseconds 300;if($process.HasExited -or [TrayNativeCheck]::IsWindowVisible($window)){throw 'Close did not hide the live candidate.'};@{hidden=$true;alive=$true}|ConvertTo-Json;exit}
# shortcut: tray-icon 0.25.1 message IDs; review this probe when tray-icon changes.
# MN_GETHMENU: https://learn.microsoft.com/windows/win32/winmsg/mn-gethmenu
$buttonMessage=if($Action -eq 'left'){0x202}else{0x205}
if(![TrayNativeCheck]::PostMessage($trayWindow,6002,[IntPtr]$trayId,[IntPtr]$buttonMessage)){throw 'Native tray notification failed.'}
if($Action -eq 'left'){Start-Sleep -Milliseconds 300;if(![TrayNativeCheck]::IsWindowVisible($window)){throw 'Tray notification did not restore the window.'};@{restored=$true;inputMode='owned Windows tray notification'}|ConvertTo-Json;exit}
$deadline=[DateTime]::UtcNow.AddSeconds(3);$popup=[IntPtr]::Zero
while($popup -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline){$popup=[TrayNativeCheck]::Window($process.Id,'#32768');if($popup -eq [IntPtr]::Zero){Start-Sleep -Milliseconds 100}}
if($popup -eq [IntPtr]::Zero){throw 'Candidate native context menu unavailable.'}
$menu=[TrayNativeCheck]::SendMessage($popup,0x1E1,[IntPtr]::Zero,[IntPtr]::Zero)
if($menu -eq [IntPtr]::Zero){throw 'Owned popup menu handle unavailable.'}
$items=@()
for($index=0;$index -lt [TrayNativeCheck]::GetMenuItemCount($menu);$index++){
 $text=[Text.StringBuilder]::new(256)
 [void][TrayNativeCheck]::GetMenuString($menu,$index,$text,$text.Capacity,0x400)
 if($text.Length){$items+=@{name=$text.ToString().Replace('&','');id=[TrayNativeCheck]::GetMenuItemID($menu,$index)}}
}
$names=@{open=@('열기','Open DockSlate');settings=@('설정','Settings');containers=@('컨테이너','Containers');images=@('이미지','Images');refresh=@('전체 새로고침','Refresh all');quit=@('완전 종료','Quit DockSlate')}
$menuNames=@($items|ForEach-Object{$_.name})
$itemAction=if($Action -eq 'menu'){'open'}else{$Action}
$target=@($items|Where-Object{$_.name -cin $names[$itemAction]})
if($target.Count -ne 1){throw ('Unique native menu item unavailable: '+($menuNames|ConvertTo-Json -Compress))}
[void][TrayNativeCheck]::PostMessage($trayWindow,0x1F,[IntPtr]::Zero,[IntPtr]::Zero)
[void][TrayNativeCheck]::PostMessage($trayWindow,0x111,[IntPtr]$target[0].id,[IntPtr]::Zero)
if($Action -eq 'menu'){$menuNames|ConvertTo-Json;exit}
if($Action -eq 'quit'){if(!$process.WaitForExit(10000)){throw 'Tray quit did not exit the candidate.'};$exitCode=[uint32]259;if(![TrayNativeCheck]::GetExitCodeProcess($processHandle,[ref]$exitCode)){throw 'Candidate exit code unavailable.'};@{quit=$true;exitCode=$exitCode;inputMode='native Windows menu invocation'}|ConvertTo-Json}else{@{clicked=$itemAction;inputMode='native Windows menu invocation'}|ConvertTo-Json}
