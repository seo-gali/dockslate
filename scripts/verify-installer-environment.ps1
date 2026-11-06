$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixtureRoot = Join-Path $projectRoot ('.analysis\installer-notify-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$worker = $null
$passed = $false
$checks = [Collections.Generic.List[object]]::new()
$utf8 = [Text.UTF8Encoding]::new($false)
$source = [IO.File]::ReadAllText((Join-Path $projectRoot 'src-tauri\installer\hooks.nsh'))
$macro = [regex]::Matches($source, '(?ms)^!macro DockSlateEnvironmentFunctions PREFIX\r?\n.*?^!macroend')
if ($macro.Count -ne 1) { throw 'Expected the production environment notification macro.' }
$environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$options = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
$beforePath = if ($environmentKey) { $environmentKey.GetValue('Path', $null, $options) } else { $null }
$beforeKind = if ($environmentKey -and $environmentKey.GetValueNames() -contains 'Path') { $environmentKey.GetValueKind('Path') } else { $null }
try {
    $ready = Join-Path $fixtureRoot 'ready.txt'
    $received = Join-Path $fixtureRoot 'received.txt'
    $workerScript = Join-Path $fixtureRoot 'windows.ps1'
    $workerSource = @'
param([string]$ReadyFile, [string]$ReceivedFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.IO;
using System.Collections.Generic;
using System.Threading;
using System.Windows.Forms;
public sealed class DelayedEnvironmentWindow : NativeWindow {
    static readonly object gate=new object();
    readonly string receipt;
    public DelayedEnvironmentWindow(string file) {receipt=file;CreateHandle(new CreateParams {Caption="DockSlate notification verification",Parent=IntPtr.Zero});}
    protected override void WndProc(ref Message m) {
        if(m.Msg==0x1A) {lock(gate) {File.AppendAllText(receipt,"Environment received\n");} Thread.Sleep(5000);}
        base.WndProc(ref m);
    }
}
public static class NotificationTestWindows {
    public static void Run(string readyFile,string receivedFile) {
        var handles=new List<long>();
        var ready=new CountdownEvent(24);
        for(int i=0;i<24;i++) {
            var thread=new Thread(()=>{
                var window=new DelayedEnvironmentWindow(receivedFile);
                lock(handles) {handles.Add(window.Handle.ToInt64());}
                ready.Signal();
                Application.Run();
                GC.KeepAlive(window);
            });
            thread.IsBackground=true;thread.SetApartmentState(ApartmentState.STA);thread.Start();
        }
        ready.Wait();File.WriteAllText(readyFile,string.Join(",",handles));
        Thread.Sleep(Timeout.Infinite);
    }
}
"@
[NotificationTestWindows]::Run($ReadyFile,$ReceivedFile)
'@
    [IO.File]::WriteAllText($workerScript, $workerSource, $utf8)
    $worker = [Diagnostics.Process]::new()
    $worker.StartInfo.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $worker.StartInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + $workerScript + '" -ReadyFile "' + $ready + '" -ReceivedFile "' + $received + '"'
    $worker.StartInfo.UseShellExecute = $false
    $worker.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $worker.StartInfo.CreateNoWindow = $true
    if (!$worker.Start()) { throw 'Test windows failed to start.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    while (!(Test-Path -LiteralPath $ready)) {
        if ($worker.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Delayed test windows were not ready.' }
        Start-Sleep -Milliseconds 100
    }
    $fixtureSource = @'
Unicode true
Name "DockSlate environment notification verification"
OutFile "@@OUTPUT@@"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
!include "LogicLib.nsh"
!include "WinMessages.nsh"
@@MACRO@@
!insertmacro DockSlateEnvironmentFunctions ""
!insertmacro DockSlateEnvironmentFunctions "un."
!macro CheckNotification PREFIX RESULT
  StrCpy $0 "preserved0"
  StrCpy $1 "preserved1"
  StrCpy $2 "preserved2"
  StrCpy $3 "preserved3"
  StrCpy $4 "preserved4"
  StrCpy $5 "preserved5"
  System::Call 'kernel32::GetTickCount() i.r6'
  Call ${PREFIX}DockSlateNotifyEnvironment
  System::Call 'kernel32::GetTickCount() i.r7'
  IntOp $7 $7 - $6
  StrCmp $0 "preserved0" +2
    Abort "Register 0 changed"
  StrCmp $1 "preserved1" +2
    Abort "Register 1 changed"
  StrCmp $2 "preserved2" +2
    Abort "Register 2 changed"
  StrCmp $3 "preserved3" +2
    Abort "Register 3 changed"
  StrCmp $4 "preserved4" +2
    Abort "Register 4 changed"
  StrCmp $5 "preserved5" +2
    Abort "Register 5 changed"
  FileOpen $8 "${RESULT}" w
  FileWrite $8 "$7"
  FileClose $8
!macroend
Section
  WriteUninstaller "@@UNINSTALLER@@"
  System::Call 'kernel32::GetTickCount() i.r6'
  SendMessage @@SLOWWINDOW@@ ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  System::Call 'kernel32::GetTickCount() i.r7'
  IntOp $7 $7 - $6
  FileOpen $8 "@@BASERESULT@@" w
  FileWrite $8 "$7"
  FileClose $8
  !insertmacro CheckNotification "" "@@INSTALLRESULT@@"
SectionEnd
Section "Uninstall"
  !insertmacro CheckNotification "un." "@@UNINSTALLRESULT@@"
SectionEnd
'@
    $fixtureExe = Join-Path $fixtureRoot 'notify.exe'
    $fixtureUninstaller = Join-Path $fixtureRoot 'uninstall.exe'
    $installResult = Join-Path $fixtureRoot 'install.txt'
    $uninstallResult = Join-Path $fixtureRoot 'uninstall.txt'
    $baselineResult = Join-Path $fixtureRoot 'baseline.txt'
    $slowWindow = [long]([IO.File]::ReadAllText($ready).Split(',')[0])
    $fixtureSource = $fixtureSource.Replace('@@MACRO@@', $macro[0].Value).Replace('@@OUTPUT@@', $fixtureExe).Replace('@@UNINSTALLER@@', $fixtureUninstaller).Replace('@@INSTALLRESULT@@', $installResult).Replace('@@UNINSTALLRESULT@@', $uninstallResult).Replace('@@BASERESULT@@',$baselineResult).Replace('@@SLOWWINDOW@@',$slowWindow.ToString())
    $fixtureScript = Join-Path $fixtureRoot 'notify.nsi'
    [IO.File]::WriteAllText($fixtureScript, $fixtureSource, $utf8)
    & (Join-Path $projectRoot 'src-tauri\target\.tauri\NSIS\Bin\makensis.exe') /V2 /INPUTCHARSET UTF8 $fixtureScript
    if ($LASTEXITCODE -ne 0) { throw 'Production notification macro compilation failed.' }
    foreach ($probe in @(@{name='installer';exe=$fixtureExe;result=$installResult;args='/S'}, @{name='uninstaller';exe=$fixtureUninstaller;result=$uninstallResult;args=('/S _?='+$fixtureRoot)})) {
        $process = [Diagnostics.Process]::new()
        $process.StartInfo.FileName = $probe.exe
        $process.StartInfo.Arguments = $probe.args
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        if (!$process.Start() -or !$process.WaitForExit(15000)) { throw 'Notification probe did not finish.' }
        if ($process.ExitCode -ne 0 -or !(Test-Path -LiteralPath $probe.result)) { throw 'Notification probe or register preservation failed.' }
        $elapsed = [int][IO.File]::ReadAllText($probe.result)
        if ($elapsed -gt 2500) { throw ('Notification exceeded its total budget: '+$elapsed+' ms') }
        $checks.Add([ordered]@{name=$probe.name;elapsedMs=$elapsed;registersPreserved=$true})
    }
    if (!(Test-Path -LiteralPath $received)) { throw 'No delayed test window received the environment notification.' }
    $afterPath = if ($environmentKey) { $environmentKey.GetValue('Path', $null, $options) } else { $null }
    $afterKind = if ($environmentKey -and $environmentKey.GetValueNames() -contains 'Path') { $environmentKey.GetValueKind('Path') } else { $null }
    if ($afterPath -cne $beforePath -or $afterKind -ne $beforeKind) { throw 'Real PATH changed during notification verification.' }
    $baselineMs = [int][IO.File]::ReadAllText($baselineResult)
    if ($baselineMs -lt 4500) { throw 'The original per-window wait was not reproduced.' }
    if (@($checks | Where-Object {$_.elapsedMs -ge 1900}).Count -eq 0) { throw 'The total notification budget was not exercised.' }
    $sourceSha = [Security.Cryptography.SHA256]::Create()
    try { $sourceHash = [BitConverter]::ToString($sourceSha.ComputeHash($utf8.GetBytes($source.Replace("`r`n","`n")))).Replace('-','') } finally { $sourceSha.Dispose() }
    $report = [ordered]@{observedAt=[DateTime]::UtcNow.ToString('o');scope='Actual compiled NSIS install/uninstall notification functions; 24 hidden windows on separate threads delay handling by 5000 ms; no real installation or removal';source='src-tauri/installer/hooks.nsh';sourceNormalization='LF';sourceSha256=$sourceHash;originalSingleWindowWaitMs=$baselineMs;checks=$checks.ToArray();delayedWindowReceived=$true;realPathUnchanged=$true;engineChanged=$false;passed=$true}
    [IO.File]::WriteAllText((Join-Path $projectRoot 'docs\results\installer-delay.json'),($report|ConvertTo-Json -Depth 5),$utf8)
    $passed = $true
    $report | ConvertTo-Json -Depth 5
} finally {
    if ($worker -and !$worker.HasExited) { $worker.Kill(); $worker.WaitForExit() }
    if ($worker) { $worker.Dispose() }
    if ($environmentKey) { $environmentKey.Dispose() }
    if ($passed) {
        $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
        if ([IO.Path]::GetDirectoryName($resolvedFixture) -ne (Join-Path $projectRoot '.analysis') -or [IO.Path]::GetFileName($resolvedFixture) -notmatch '^installer-notify-[a-f0-9]{32}$') { throw 'Unexpected verification cleanup target.' }
        Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
    }
}
