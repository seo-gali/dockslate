# Docker Desktop 제거 사전 확인

2026-10-14 Windows 호스트에서 읽기 전용으로 확인했다. 사용자는 Docker Desktop 제거와 실제 VHDX 삭제를 승인했다. 이 기록을 작성한 진단에서는 제거·삭제·WSL 기동·종료·디스크 연결 변경을 실행하지 않았다.

## 설치 대상

- 설치 레지스트리: `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop`
- 표시 버전: `4.57.0`, 실제 설치 관리자 버전: `4.57.0.215387`
- 설치 경로: `C:\Program Files\Docker\Docker`
- 레지스트리 제거 명령: `"C:\Program Files\Docker\Docker\Docker Desktop Installer.exe" "uninstall"`
- 설치 관리자: 5,980,080 bytes, Authenticode `Valid`, 서명자 Docker Inc.
- 설치 관리자 SHA-256: `DBA0643EF9CDCA6723CE0E158E4EF8531B880651D8EF89DA9C4D4E1E7C85AB8F`
- `com.docker.service`: Stopped / Manual, 실행 경로는 위 Docker 설치 디렉터리 내부.
- 이 진단 시점에 `Docker Desktop`, `com.docker.backend`, `com.docker.build`, `dockerd`, `cagent` 프로세스는 발견되지 않았다.
- 현재 Windows `docker.exe`는 `C:\Program Files\Docker\Docker\resources\bin\docker.exe`를 가리킨다. 제거 후 이 CLI가 없어질 수 있다. DockSlate의 전용 WSL CLI와 구분해야 한다.

## 실제 VHDX 두 개

| 대상 | 확인한 파일 | 파일 크기 | 소유 근거 |
| --- | --- | ---: | --- |
| Desktop 시스템 배포판 | `C:\Users\user\AppData\Local\Docker\wsl\main\ext4.vhdx` | 109,051,904 bytes (104 MiB) | WSL 등록 `docker-desktop`, GUID `{0864a004-b3b1-4157-8d54-186ec6a3d252}`, Version 2, BasePath와 VhdFileName 일치 |
| Desktop Docker 데이터 | `C:\Users\user\AppData\Local\Docker\wsl\disk\docker_data.vhdx` | 20,675,821,568 bytes (약 19.26 GiB) | Docker 기본 WSL 데이터 디렉터리 내부의 실제 파일이며 공식 백업 문서가 명시하는 파일명·위치와 일치 |

`wsl.exe --list --verbose`에서 `docker-desktop`만 등록되고 Stopped 상태였다. `--list --running --quiet`는 빈 목록이었다. `Docker\wsl`부터 드라이브 루트까지 디렉터리 조상에 ReparsePoint는 없었다. 별도 데이터 VHDX는 등록된 시스템 VHDX와 다른 파일이다. 기존 UI의 104 MiB 표시만으로 Desktop 전체 데이터 크기를 판단할 수 없다.

## 공식 제거 경로와 실행 시 확인할 조건

Docker 공식 Windows 절차는 설치 관리자에 `uninstall` 인수를 전달하고 완료를 기다리는 방식이다. 이 진단은 추가 `--quiet` 등의 제거 인수를 검증하지 않았다. 제거는 Desktop의 로컬 컨테이너·이미지·볼륨 데이터에도 영향을 준다. [Docker 공식 제거 문서](https://docs.docker.com/desktop/uninstall/)

DockSlate 전용 엔진의 독립 실행을 확인한 뒤 서명된 위 설치 관리자만 실행한다. 완료 후 제거 레지스트리, 서비스, Desktop 실행 파일, WSL 등록 및 두 VHDX의 실제 잔존 여부를 다시 확인한다. 공식 제거기가 이미 삭제한 파일을 다시 삭제 대상으로 취급하지 않는다. 잔존 VHDX를 삭제한다면 위의 두 개별 경로를 대상으로 소유권·조상 경로·분리·파일 잠금 조건을 다시 확인한다. DockSlate 배포판 또는 전용 디스크를 함께 삭제하지 않는다.

Docker의 기본 WSL 데이터 경로는 `%LOCALAPPDATA%\Docker\wsl`이며, 별도 Linux 배포판과 `docker-desktop`은 구분된다. [Docker WSL 문서](https://docs.docker.com/desktop/features/wsl/)

공식 백업 문서는 WSL 데이터 파일 `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`를 명시하며 백업 전에 Desktop을 완전히 종료하도록 안내한다. [Docker 공식 백업 문서](https://docs.docker.com/desktop/settings-and-maintenance/backup-and-restore/)

## 미확인 사항

- 이 진단은 VHDX 내용, Docker 객체 목록, 데이터의 중요도, 백업 존재·복구 가능성을 확인하지 않았다. 삭제 승인과 데이터 백업 검증은 다른 사실이다.
- 두 VHDX의 실제 연결·분리 상태와 배타적 삭제 가능 여부를 이 진단에서 검증하지 않았다.
- 설치 관리자 제거가 다른 WSL 배포판이나 기본 배포판 설정을 유지하는지는 이 PC에서 아직 실행 검증하지 않았다.
- `.docker`는 다른 엔진의 context·자격 증명도 포함할 수 있어 열람·포괄 삭제 대상으로 삼지 않았다.
- 파일 길이는 Windows에서 실제 회수할 저장 공간과 동일하지 않다. 삭제 후 Windows 여유 공간 변화는 별도 측정이 필요하다.
