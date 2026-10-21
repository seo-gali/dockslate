; https://v2.tauri.app/distribute/windows-installer/#extending-the-installer
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "x64.nsh"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define DOCKSLATE_INSTALLER_KEY "Software\DockSlate\Installer"
!define DOCKSLATE_PATH_SCRIPT_SOURCE "${__FILEDIR__}\user-path.ps1"

Var DockSlatePathMode
Var DockSlatePathExit
Var DockSlateWslExecutable
Var DockSlateWslStatus
Var DockSlateWslMessage
Var DockSlateSetupResult

Function DockSlateReadWslStatus
  Push $0
  Push $1
  StrCpy $DockSlateWslStatus "missing"
  IfFileExists "$DockSlateWslExecutable" 0 wsl_status_done
  nsExec::ExecToStack /TIMEOUT=30000 '"$DockSlateWslExecutable" --status'
  Pop $0
  Pop $1
  StrCpy $DockSlateWslStatus $0
wsl_status_done:
  Pop $1
  Pop $0
FunctionEnd

Function DockSlateRequireWsl
  StrCpy $DockSlateWslExecutable "$SYSDIR\wsl.exe"
  ${If} ${RunningX64}
    StrCpy $DockSlateWslExecutable "$WINDIR\Sysnative\wsl.exe"
  ${EndIf}
  Call DockSlateReadWslStatus
  ${If} $DockSlateWslStatus == "0"
    DetailPrint "Microsoft WSL status check passed. The app verifies WSL 2 and prepares its Docker Engine during installation."
    ClearErrors
    Return
  ${EndIf}
  StrCpy $DockSlateWslMessage "DockSlate needs WSL 2 to run Docker Engine. WSL is missing or its status check failed.$\r$\n$\r$\nChoose OK to authorize Microsoft's WSL installation:$\r$\nwsl --install --no-distribution$\r$\n$\r$\nThis can enable Windows virtualization features and download Microsoft WSL. Internet access and administrator approval (UAC) are required. Windows may require a restart. No general-purpose Linux distribution will be installed, and existing distributions and Docker data will be preserved.$\r$\n$\r$\nCancel stops DockSlate installation."
  ${If} $LANGUAGE = 1042
    StrCpy $DockSlateWslMessage "DockSlate에서 Docker Engine을 실행하려면 WSL 2가 필요합니다. WSL이 없거나 준비 상태를 확인하지 못했습니다.$\r$\n$\r$\n확인을 누르면 Microsoft의 다음 WSL 설치를 승인합니다.$\r$\nwsl --install --no-distribution$\r$\n$\r$\nWindows 가상화 기능을 활성화하고 Microsoft WSL을 다운로드할 수 있습니다. 인터넷 연결과 관리자 권한 승인(UAC)이 필요하며 Windows 재시작이 필요할 수 있습니다. 일반 Linux 배포판은 설치하지 않으며 기존 배포판과 Docker 데이터는 보존합니다.$\r$\n$\r$\n취소를 누르면 DockSlate 설치를 중단합니다."
  ${EndIf}
  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "$DockSlateWslMessage" /SD IDCANCEL IDOK wsl_install_approved
  StrCpy $DockSlateWslMessage "WSL installation was not approved. DockSlate installation was stopped without enabling WSL or creating its Docker Engine."
  ${If} $LANGUAGE = 1042
    StrCpy $DockSlateWslMessage "WSL 설치를 승인하지 않아 DockSlate 설치를 중단했습니다. WSL 기능 활성화나 DockSlate Docker Engine 생성은 수행하지 않았습니다."
  ${EndIf}
  SetErrorLevel 2
  Abort "$DockSlateWslMessage"
wsl_install_approved:
  IfFileExists "$DockSlateWslExecutable" wsl_install_launch
  StrCpy $DockSlateWslMessage "The Windows system wsl.exe is unavailable, so Microsoft's WSL install command cannot be launched. Repair or install WSL using https://learn.microsoft.com/windows/wsl/install, then run DockSlate Setup again. DockSlate installation was stopped."
  ${If} $LANGUAGE = 1042
    StrCpy $DockSlateWslMessage "Windows 시스템의 wsl.exe를 찾을 수 없어 Microsoft WSL 설치 명령을 실행할 수 없습니다. https://learn.microsoft.com/windows/wsl/install 안내에 따라 WSL을 설치하거나 복구한 뒤 DockSlate 설치를 다시 실행하세요. DockSlate 설치를 중단했습니다."
  ${EndIf}
  MessageBox MB_OK|MB_ICONSTOP "$DockSlateWslMessage" /SD IDOK
  SetErrorLevel 2
  Abort "$DockSlateWslMessage"
wsl_install_launch:
  DetailPrint "Starting explicitly approved Microsoft WSL installation with administrator approval. No Linux distribution is requested."
  ClearErrors
  ExecShellWait "runas" "$DockSlateWslExecutable" "--install --no-distribution" SW_SHOWNORMAL
  ${If} ${Errors}
    StrCpy $DockSlateWslMessage "Administrator approval was declined, or Microsoft WSL installation could not be started. DockSlate installation was stopped."
    ${If} $LANGUAGE = 1042
      StrCpy $DockSlateWslMessage "관리자 승인이 거절되었거나 Microsoft WSL 설치를 시작하지 못했습니다. DockSlate 설치를 중단했습니다."
    ${EndIf}
    MessageBox MB_OK|MB_ICONSTOP "$DockSlateWslMessage" /SD IDOK
    SetErrorLevel 2
    Abort "$DockSlateWslMessage"
  ${EndIf}
  Call DockSlateReadWslStatus
  ${If} $DockSlateWslStatus != "0"
    StrCpy $DockSlateWslMessage "Microsoft WSL installation returned, but WSL is not ready. If Windows requested a restart, save your work and restart Windows, then run DockSlate Setup again. If it still fails, review the Microsoft WSL installer output. DockSlate has not created a Docker Engine or containers. No automatic restart was requested by DockSlate."
    ${If} $LANGUAGE = 1042
      StrCpy $DockSlateWslMessage "Microsoft WSL 설치가 종료되었지만 WSL 준비 상태를 확인하지 못했습니다. Windows에서 재시작을 안내했다면 작업을 저장하고 Windows를 다시 시작한 뒤 DockSlate 설치를 재실행하세요. 계속 실패하면 Microsoft WSL 설치창의 오류를 확인하세요. DockSlate Docker Engine이나 컨테이너는 생성하지 않았으며 자동 재부팅을 요청하지 않았습니다."
    ${EndIf}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$DockSlateWslMessage" /SD IDOK
    SetErrorLevel 2
    Abort "$DockSlateWslMessage"
  ${EndIf}
  DetailPrint "Microsoft WSL status check passed after the approved installation."
  ClearErrors
FunctionEnd

!macro DockSlatePathFunctions PREFIX
Function ${PREFIX}DockSlateUpdateUserPath
  Push $0
  Push $1
  StrCpy $DockSlatePathExit 1
  InitPluginsDir
  ClearErrors
  File "/oname=$PLUGINSDIR\dockslate-user-path.ps1" "${DOCKSLATE_PATH_SCRIPT_SOURCE}"
  ${If} ${Errors}
    Goto path_update_done
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "DOCKSLATE_PATH_SCRIPT", w "$PLUGINSDIR\dockslate-user-path.ps1")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "DOCKSLATE_PATH_MODE", w "$DockSlatePathMode")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "DOCKSLATE_PATH_BIN", w "$INSTDIR\bin")'
  StrCpy $0 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${If} ${RunningX64}
    StrCpy $0 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  ; Keep the complete registry value in .NET, outside NSIS's fixed-size strings.
  nsExec::ExecToStack /TIMEOUT=30000 `"$0" -NoLogo -NoProfile -NonInteractive -Command "& ([scriptblock]::Create([IO.File]::ReadAllText($$env:DOCKSLATE_PATH_SCRIPT)))"`
  Pop $DockSlatePathExit
  Pop $1
  ${If} $DockSlatePathExit != "0"
    DetailPrint "Windows PATH operation failed: $1"
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "DOCKSLATE_PATH_SCRIPT", p 0)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "DOCKSLATE_PATH_MODE", p 0)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "DOCKSLATE_PATH_BIN", p 0)'
path_update_done:
  Pop $1
  Pop $0
FunctionEnd
!macroend

!insertmacro DockSlatePathFunctions ""
!insertmacro DockSlatePathFunctions "un."

!macro NSIS_HOOK_PREINSTALL
  IfSilent setup_silent_unsupported setup_interactive
setup_silent_unsupported:
  SetErrorLevel 2
  Abort "Interactive setup is required to review and approve Docker Engine installation or startup. No engine changes were approved."
setup_interactive:
  StrCpy $DockSlatePathMode "check"
  Call DockSlateUpdateUserPath
  ${If} $DockSlatePathExit != "0"
    SetErrorLevel 2
    ${If} $LANGUAGE = 1042
      Abort "사용자 PATH를 확인할 수 없어 설치를 중단했습니다. 기존 PATH와 엔진 데이터는 보존했습니다."
    ${EndIf}
    Abort "The current user's PATH could not be checked. Existing PATH entries and engine data were preserved."
  ${EndIf}
  Call DockSlateRequireWsl
!macroend

!macro NSIS_HOOK_POSTINSTALL
  StrCpy $DockSlatePathMode "install"
  Call DockSlateUpdateUserPath
  ${If} $DockSlatePathExit != "0"
    SetErrorLevel 2
    ${If} $LANGUAGE = 1042
      Abort "Windows docker 명령 등록을 완료하지 못했습니다. 설치 상세 내역의 PATH 오류를 확인하세요. 기존 엔진 데이터는 보존했습니다."
    ${EndIf}
    Abort "Windows docker command registration is incomplete. Review the PATH error in the installation details. Existing engine data was preserved."
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  DetailPrint "Verified the DockSlate bin folder in this user's PATH. Open a new terminal to use docker."
  IfFileExists "$INSTDIR\dockslate.exe" 0 setup_files_missing
  IfFileExists "$INSTDIR\bin\docker.exe" 0 setup_files_missing
  DetailPrint "Preparing Docker Engine, Docker CLI, Compose and Buildx. Review the target and approve installation or startup in the setup window."
  SetOutPath "$INSTDIR"
  ClearErrors
  ExecWait '"$INSTDIR\dockslate.exe" --installer-setup' $DockSlateSetupResult
  ${If} ${Errors}
    StrCpy $DockSlateSetupResult 1
  ${EndIf}
  ${If} $DockSlateSetupResult <> 0
    SetErrorLevel 2
    ${If} $LANGUAGE = 1042
      Abort "Docker Engine 준비를 취소했거나 엔진·Windows docker 명령 검증을 완료하지 못했습니다. 준비창의 오류와 PATH 충돌 여부를 확인하세요. 앱 파일과 기존 엔진 데이터는 보존했습니다. DockSlate 설치를 다시 실행하여 완료하세요."
    ${EndIf}
    Abort "Setup was cancelled, or Docker Engine and the Windows docker command could not be verified. Review the setup error and any PATH conflict. Application files and existing engine data are preserved. Run DockSlate Setup again to finish."
  ${EndIf}
  DetailPrint "Docker Engine, the new-terminal docker command, Compose and Buildx were verified. Open a new terminal to use docker."
  Goto setup_complete
setup_files_missing:
  SetErrorLevel 2
  ${If} $LANGUAGE = 1042
    Abort "설치한 앱 또는 Windows Docker CLI 파일이 없습니다. 엔진 준비는 시작하지 않았습니다."
  ${EndIf}
  Abort "The installed app or Windows Docker CLI is missing. Docker Engine setup was not started."
setup_complete:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  StrCpy $DockSlatePathMode "uninstall"
  Call un.DockSlateUpdateUserPath
  ${If} $DockSlatePathExit == "0"
    DeleteRegKey /ifempty HKCU "${DOCKSLATE_INSTALLER_KEY}"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${Else}
    DetailPrint "The owned PATH entry could not be removed. Other entries were preserved."
  ${EndIf}
  DetailPrint "DockSlate WSL distributions, containers, images, volumes and runtime disks are preserved."
!macroend
