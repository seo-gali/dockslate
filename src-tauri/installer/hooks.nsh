; https://v2.tauri.app/distribute/windows-installer/#extending-the-installer
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "x64.nsh"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define DOCKSLATE_INSTALLER_KEY "Software\DockSlate\Installer"

Var DockSlatePathOriginal
Var DockSlatePathResult
Var DockSlatePathEntry
Var DockSlatePathToken
Var DockSlatePathPosition
Var DockSlatePathLength
Var DockSlatePathCharacter
Var DockSlatePathReadable
Var DockSlatePathPresent
Var DockSlatePathType
Var DockSlatePathFound
Var DockSlatePathRetained
Var DockSlateWslExecutable
Var DockSlateWslStatus
Var DockSlateWslMessage

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
    DetailPrint "Microsoft WSL status check passed. The app verifies WSL 2 and installs its own Docker Engine during first-run setup."
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
Function ${PREFIX}DockSlateReadUserPath
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $DockSlatePathReadable 0
  StrCpy $DockSlatePathPresent 0
  StrCpy $DockSlatePathOriginal ""
  StrCpy $DockSlatePathType 2
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "Environment", i 0, i 0x20019, *p .r0) i .r1'
  ${If} $1 = 2
    StrCpy $DockSlatePathReadable 1
    Goto read_done
  ${EndIf}
  ${If} $1 <> 0
    Goto read_done
  ${EndIf}
  System::Call 'advapi32::RegQueryValueExW(p r0, w "Path", p 0, *i .r2, p 0, *i .r3) i .r1'
  System::Call 'advapi32::RegCloseKey(p r0)'
  ${If} $1 = 2
    StrCpy $DockSlatePathReadable 1
    Goto read_done
  ${EndIf}
  ${If} $1 <> 0
    Goto read_done
  ${EndIf}
  ${If} $2 <> 1
  ${AndIf} $2 <> 2
    Goto read_done
  ${EndIf}
  IntOp $4 ${NSIS_MAX_STRLEN} * 2
  ${If} $3 > $4
    Goto read_done
  ${EndIf}
  ClearErrors
  ReadRegStr $DockSlatePathOriginal HKCU "Environment" "Path"
  ${IfNot} ${Errors}
    StrCpy $DockSlatePathType $2
    StrCpy $DockSlatePathPresent 1
    StrCpy $DockSlatePathReadable 1
  ${EndIf}
read_done:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${PREFIX}DockSlateScanUserPath
  StrCpy $DockSlatePathResult ""
  StrCpy $DockSlatePathToken ""
  StrCpy $DockSlatePathFound 0
  StrCpy $DockSlatePathRetained 0
  StrCpy $DockSlatePathPosition 0
  StrLen $DockSlatePathLength $DockSlatePathOriginal
scan_next:
  ${If} $DockSlatePathPosition >= $DockSlatePathLength
    Goto scan_token
  ${EndIf}
  StrCpy $DockSlatePathCharacter $DockSlatePathOriginal 1 $DockSlatePathPosition
  ${If} $DockSlatePathCharacter == ";"
    Goto scan_token
  ${EndIf}
  StrCpy $DockSlatePathToken "$DockSlatePathToken$DockSlatePathCharacter"
  IntOp $DockSlatePathPosition $DockSlatePathPosition + 1
  Goto scan_next
scan_token:
  ${If} $DockSlatePathToken == $DockSlatePathEntry
    StrCpy $DockSlatePathFound 1
  ${Else}
    ${If} $DockSlatePathRetained = 0
      StrCpy $DockSlatePathResult $DockSlatePathToken
    ${Else}
      StrCpy $DockSlatePathResult "$DockSlatePathResult;$DockSlatePathToken"
    ${EndIf}
    IntOp $DockSlatePathRetained $DockSlatePathRetained + 1
  ${EndIf}
  StrCpy $DockSlatePathToken ""
  ${If} $DockSlatePathPosition >= $DockSlatePathLength
    Return
  ${EndIf}
  IntOp $DockSlatePathPosition $DockSlatePathPosition + 1
  Goto scan_next
FunctionEnd

Function ${PREFIX}DockSlateWriteUserPath
  ClearErrors
  ${If} $DockSlatePathType = 1
    WriteRegStr HKCU "Environment" "Path" $DockSlatePathResult
  ${Else}
    WriteRegExpandStr HKCU "Environment" "Path" $DockSlatePathResult
  ${EndIf}
  ${IfNot} ${Errors}
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
FunctionEnd
!macroend

!insertmacro DockSlatePathFunctions ""
!insertmacro DockSlatePathFunctions "un."

!macro NSIS_HOOK_PREINSTALL
  Call DockSlateReadUserPath
  ${If} $DockSlatePathReadable <> 1
    MessageBox MB_ICONSTOP "The current user's PATH could not be read without truncation. Installation was stopped without changing PATH."
    Abort
  ${EndIf}
  Call DockSlateRequireWsl
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  StrCpy $DockSlatePathEntry "$INSTDIR\bin"
  Call DockSlateReadUserPath
  ${If} $DockSlatePathReadable <> 1
    DetailPrint "PATH was not changed: it could not be read safely."
    Goto path_install_done
  ${EndIf}
  Call DockSlateScanUserPath
  ${If} $DockSlatePathFound = 1
    Goto path_install_done
  ${EndIf}
  StrLen $0 $DockSlatePathOriginal
  StrLen $1 $DockSlatePathEntry
  IntOp $0 $0 + $1
  IntOp $0 $0 + 2
  ${If} $0 >= ${NSIS_MAX_STRLEN}
    DetailPrint "PATH was not changed: adding DockSlate would exceed the installer string limit."
    MessageBox MB_ICONEXCLAMATION "DockSlate was installed, but PATH is too long to update safely. Add the installed bin folder to your user PATH manually."
    Goto path_install_done
  ${EndIf}
  ${If} $DockSlatePathOriginal == ""
    StrCpy $DockSlatePathResult $DockSlatePathEntry
  ${Else}
    StrCpy $DockSlatePathResult "$DockSlatePathOriginal;$DockSlatePathEntry"
  ${EndIf}
  Call DockSlateWriteUserPath
  ${IfNot} ${Errors}
    WriteRegStr HKCU "${DOCKSLATE_INSTALLER_KEY}" "PathEntry" $DockSlatePathEntry
    WriteRegDWORD HKCU "${DOCKSLATE_INSTALLER_KEY}" "PathAdded" 1
    WriteRegDWORD HKCU "${DOCKSLATE_INSTALLER_KEY}" "PathWasPresent" $DockSlatePathPresent
    DetailPrint "Added the DockSlate bin folder to this user's PATH. Open a new terminal to use docker."
  ${Else}
    MessageBox MB_ICONEXCLAMATION "DockSlate was installed, but its bin folder could not be added to your user PATH."
  ${EndIf}
path_install_done:
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Push $0
  Push $1
  StrCpy $DockSlatePathEntry "$INSTDIR\bin"
  ReadRegDWORD $0 HKCU "${DOCKSLATE_INSTALLER_KEY}" "PathAdded"
  ReadRegStr $1 HKCU "${DOCKSLATE_INSTALLER_KEY}" "PathEntry"
  ${If} $0 <> 1
  ${OrIf} $1 != $DockSlatePathEntry
    Goto path_uninstall_done
  ${EndIf}
  Call un.DockSlateReadUserPath
  ${If} $DockSlatePathReadable <> 1
    DetailPrint "PATH was preserved because it could not be read safely."
    Goto path_uninstall_done
  ${EndIf}
  Call un.DockSlateScanUserPath
  ${If} $DockSlatePathFound = 1
    ReadRegDWORD $0 HKCU "${DOCKSLATE_INSTALLER_KEY}" "PathWasPresent"
    ${If} $DockSlatePathRetained = 0
    ${AndIf} $0 = 0
      ClearErrors
      DeleteRegValue HKCU "Environment" "Path"
      ${IfNot} ${Errors}
        SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
      ${EndIf}
    ${Else}
      Call un.DockSlateWriteUserPath
    ${EndIf}
    ${If} ${Errors}
      DetailPrint "The owned PATH entry could not be removed. Other entries were preserved."
      Goto path_uninstall_done
    ${EndIf}
  ${EndIf}
  DeleteRegValue HKCU "${DOCKSLATE_INSTALLER_KEY}" "PathEntry"
  DeleteRegValue HKCU "${DOCKSLATE_INSTALLER_KEY}" "PathAdded"
  DeleteRegValue HKCU "${DOCKSLATE_INSTALLER_KEY}" "PathWasPresent"
  DeleteRegKey /ifempty HKCU "${DOCKSLATE_INSTALLER_KEY}"
  DetailPrint "DockSlate WSL distributions, containers, images, volumes and runtime disks are preserved."
path_uninstall_done:
  Pop $1
  Pop $0
!macroend
