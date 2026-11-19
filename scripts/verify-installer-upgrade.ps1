$ErrorActionPreference='Stop'
$upgradeRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$upgradeId=[guid]::NewGuid().ToString('N')
$upgradeFixture=Join-Path $upgradeRoot ('.analysis/installer-upgrade-'+$upgradeId)
$upgradeKey='Software\DockSlateUpgradeVerification\'+$upgradeId
$null=New-Item -ItemType Directory -Path $upgradeFixture
$upgradeSource=[IO.File]::ReadAllText((Join-Path $upgradeRoot 'src-tauri/installer/hooks.nsh'))
$upgradeFunction=[regex]::Matches($upgradeSource,'(?ms)^Function DockSlateRestoreInstallLocation\r?\n.*?^FunctionEnd')
if($upgradeFunction.Count -ne 1 -or !$upgradeSource.Contains('!define MUI_CUSTOMFUNCTION_GUIINIT DockSlateRestoreInstallLocation')){throw 'Expected the production GUI initialization hook.'}
$upgradeBody=$upgradeFunction[0].Value.Replace('Software\Microsoft\Windows\CurrentVersion\Uninstall\DockSlate',$upgradeKey+'\Uninstall').Replace('Software\DockSlate\DockSlate',$upgradeKey+'\Product')
$upgradeReceipt=Join-Path $upgradeFixture 'checks.txt'
$upgradeProgram=@'
Unicode true
Name "DockSlate isolated upgrade registration verification"
OutFile "@@OUTPUT@@"
RequestExecutionLevel user
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define KEY "@@KEY@@"
!define APP "@@APP@@"
!define RESULT "@@RESULT@@"
!define MUI_CUSTOMFUNCTION_GUIINIT DockSlateRestoreInstallLocation
@@FUNCTION@@
!define MUI_PAGE_CUSTOMFUNCTION_PRE VerifyRecovery
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!macro Require ACTUAL EXPECTED LABEL
 ${If} "${ACTUAL}" != "${EXPECTED}"
   SetErrorLevel 3
   Quit
 ${EndIf}
 FileWrite $3 "${LABEL}$\r$\n"
!macroend
!macro Reset
 DeleteRegKey HKCU "${KEY}\Product"
 WriteRegStr HKCU "${KEY}\Uninstall" "InstallLocation" '$\"${APP}$\"'
 WriteRegStr HKCU "${KEY}\Uninstall" "UninstallString" '$\"${APP}\uninstall.exe$\"'
!macroend
!macro VersionCase VERSION
 !insertmacro Reset
 WriteRegStr HKCU "${KEY}\Uninstall" "DisplayVersion" "${VERSION}"
 Call DockSlateRestoreInstallLocation
 ReadRegStr $0 HKCU "${KEY}\Product" ""
 !insertmacro Require $0 "${APP}" "version ${VERSION} does not restrict recovery"
!macroend
Function .onInit
 StrCpy $INSTDIR "$LOCALAPPDATA\DockSlate"
 CreateDirectory "${APP}"
 FileOpen $0 "${APP}\dockslate.exe" w
 FileWrite $0 "isolated file-existence fixture only"
 FileClose $0
 FileOpen $0 "${APP}\uninstall.exe" w
 FileWrite $0 "never executed"
 FileClose $0
 !insertmacro Reset
 WriteRegStr HKCU "${KEY}\Product" "Installer Language" "1042"
FunctionEnd
Function VerifyRecovery
 FileOpen $3 "${RESULT}" w
 ReadRegStr $0 HKCU "${KEY}\Product" ""
 !insertmacro Require $0 "${APP}" "actual MUI GUI callback repairs before reinstall page"
 !insertmacro Require $INSTDIR "${APP}" "default destination follows recovered existing location"
 ReadRegStr $0 HKCU "${KEY}\Product" "Installer Language"
 !insertmacro Require $0 "1042" "existing language value preserved"
 !insertmacro VersionCase "0.1.1"
 !insertmacro VersionCase "0.1.9"
 !insertmacro VersionCase "0.1.10"
 !insertmacro VersionCase "9.9.9"
 WriteRegStr HKCU "${KEY}\Product" "" "existing-directory"
 Call DockSlateRestoreInstallLocation
 ReadRegStr $0 HKCU "${KEY}\Product" ""
 !insertmacro Require $0 "existing-directory" "existing default preserved"
 !insertmacro Reset
 WriteRegStr HKCU "${KEY}\Uninstall" "InstallLocation" "${APP}"
 Call DockSlateRestoreInstallLocation
 ReadRegStr $0 HKCU "${KEY}\Product" ""
 !insertmacro Require $0 "${APP}" "unquoted registered location supported"
 !insertmacro Reset
 StrCpy $INSTDIR "${APP}\Chosen Destination"
 Call DockSlateRestoreInstallLocation
 !insertmacro Require $INSTDIR "${APP}\Chosen Destination" "explicit different destination preserved"
 !insertmacro Reset
 WriteRegStr HKCU "${KEY}\Uninstall" "UninstallString" '$\"${APP}\other.exe$\"'
 Call DockSlateRestoreInstallLocation
 ReadRegStr $0 HKCU "${KEY}\Product" ""
 !insertmacro Require $0 "" "mismatched uninstall command rejected"
 !insertmacro Reset
 WriteRegStr HKCU "${KEY}\Uninstall" "InstallLocation" "relative-folder"
 Call DockSlateRestoreInstallLocation
 ReadRegStr $0 HKCU "${KEY}\Product" ""
 !insertmacro Require $0 "" "relative location rejected"
 !insertmacro Reset
 Delete "${APP}\uninstall.exe"
 Call DockSlateRestoreInstallLocation
 ReadRegStr $0 HKCU "${KEY}\Product" ""
 !insertmacro Require $0 "" "missing uninstaller rejected"
 FileClose $3
 SetErrorLevel 0
 Quit
FunctionEnd
Section
 SetErrorLevel 4
SectionEnd
'@
$upgradeScript=Join-Path $upgradeFixture 'verify.nsi'
$upgradeExe=Join-Path $upgradeFixture 'verify.exe'
$upgradeProgram=$upgradeProgram.Replace('@@OUTPUT@@',$upgradeExe).Replace('@@KEY@@',$upgradeKey).Replace('@@APP@@',(Join-Path $upgradeFixture 'App With Spaces')).Replace('@@RESULT@@',$upgradeReceipt).Replace('@@FUNCTION@@',$upgradeBody)
[IO.File]::WriteAllText($upgradeScript,$upgradeProgram,[Text.UTF8Encoding]::new($false))
$upgradeProcess=$null
try{
 & (Join-Path $upgradeRoot 'src-tauri/target/.tauri/NSIS/Bin/makensis.exe') /V2 /INPUTCHARSET UTF8 $upgradeScript
 if($LASTEXITCODE -ne 0){throw 'Upgrade registration fixture compilation failed.'}
 $upgradeProcess=[Diagnostics.Process]::new();$upgradeProcess.StartInfo.FileName=$upgradeExe
 $upgradeProcess.StartInfo.UseShellExecute=$false;$upgradeProcess.StartInfo.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
 if(!$upgradeProcess.Start()){throw 'Upgrade registration fixture failed to start.'}
 if(!$upgradeProcess.WaitForExit(15000)){$upgradeProcess.Kill();throw 'Owned upgrade fixture timed out.'}
 if($upgradeProcess.ExitCode -ne 0){throw ('Upgrade registration fixture failed: '+$upgradeProcess.ExitCode)}
 $checks=@([IO.File]::ReadAllLines($upgradeReceipt))
 if($checks.Count -ne 13){throw 'Expected all thirteen actual NSIS checks.'}
 $report=[ordered]@{observedAt=[DateTime]::UtcNow.ToString('o');scope='Compiled production recovery function with only registry keys redirected to a unique test key; actual Modern UI initialization before pages';checks=$checks;functionSha256=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($upgradeFunction[0].Value.Replace("`r`n","`n"))))).Replace('-','');realInstallerOrUninstallerExecuted=$false;realInstallationChanged=$false;engineChanged=$false;passed=$true}
 [IO.File]::WriteAllText((Join-Path $upgradeRoot 'docs/results/installer-upgrade.json'),($report|ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
 $report|ConvertTo-Json -Depth 4
}finally{
 if($upgradeProcess){if(!$upgradeProcess.HasExited){$upgradeProcess.Kill()};$upgradeProcess.Dispose()}
 if($upgradeKey -cne ('Software\DockSlateUpgradeVerification\'+$upgradeId)){throw 'Unexpected test registry target.'}
 [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($upgradeKey,$false)
}
