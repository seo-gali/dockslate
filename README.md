# DockSlate

> Docker Desktop 없이 사용하는 Windows용 독립 Moby 엔진과 컨테이너 관리 앱

**현재 상태: Docker Desktop 제거 후 독립 엔진 연결·실제 기능 E2E 확인.** `D:\Program Files\DockSlate\runtime\wsl`의 전용 WSL 2 배포판에서 Moby 29.8.2 / API 1.55가 실행됩니다. Windows 앱에서 컨테이너·이미지·로그·선택 정리, Windows bind mount와 localhost 접근, 엔진 중지·재시작을 검증했습니다. 초기 일괄 조회·메뉴 캐시·수동 새로고침, Docker Hub 검색과 십진 단위 표시를 실제 EXE로 확인했습니다. 메뉴·탭 이동 중 추가 데이터 조회는 0회였습니다. VHDX 압축은 실제 실행하지 않았으며 안전 조건 미충족 시 차단합니다. [현재 검증과 제한](docs/results/standalone-runtime-verification.md).

## 프로젝트

- **분석:** [REA (Reverse Engineer Anything)](https://github.com/morluto/rea) + Codex
- **분석 대상:** Windows용 Rancher Desktop(Electron, WSL2)
- **UI 참고:** [Dockhand](https://dockhand.pro/)의 정보 구성과 작업 흐름. 코드·에셋·화면은 복제하지 않음
- **플랫폼:** Windows 11
- **기술:** Tauri 2 · React · TypeScript · Rust · Docker Engine API
- **실행 방식:** DockSlate 전용 WSL 2 배포판의 Moby 엔진. Docker Desktop/Rancher Desktop 실행 파일·CLI·엔진에 의존하지 않음

공식 Ubuntu WSL 이미지와 Docker Engine 패키지를 검증해 독립 저장소에 설치합니다. 관리 API는 전용 배포판의 Unix 소켓에 연결합니다. 앱에는 기존 데이터 자동 이관이나 Docker Desktop 자동 제거 기능이 없습니다. 이 PC에서는 사용자의 별도 승인으로 독립 엔진 E2E를 먼저 통과한 뒤 Docker Desktop 공식 제거기를 실행했습니다. Desktop 등록·서비스·실행 파일과 소유 VHDX 두 파일이 제거됐고, 제거 후에도 같은 독립 엔진 ID로 E2E를 다시 통과했습니다. [제거 기록](docs/results/docker-desktop-removal.json).

## MVP 범위

| 화면 | 기능 |
| --- | --- |
| Overview | 엔진 연결 상태, 실행 중 컨테이너 수, 이미지 수, 저장 공간 요약 |
| Containers | 목록·검색·상태, 시작·중지·재시작·삭제, 로그, Compose 프로젝트별 그룹 |
| Images | 로컬 목록·필터, Docker Hub 검색·이미지 선택, Pull·Dockerfile 빌드·컨테이너 실행·삭제 |
| Disk Manager | Docker 사용량·정리 대상 분석, 미사용 이미지·빌드 캐시 선택 정리, WSL VHDX 탐색·크기 확인·조건부 압축 |
| Settings | 독립 엔진 설치·시작·중지·승인, 엔진 정보, 디스크 작업 전제 조건 안내 |

Compose 그룹은 Docker 메타데이터를 이용한 표시 기능입니다. Compose 파일 편집·배포, 터미널 Exec, Kubernetes, 원격 호스트, 계정 기능은 MVP에서 제외합니다.

앱 시작 시 엔진·컨테이너·이미지·Docker 사용량·런타임·WSL 디스크를 하나의 스냅샷으로 조회합니다. 메뉴·탭 이동은 저장된 결과와 입력 상태를 즉시 표시하며 추가 조회를 하지 않습니다. 어느 화면에서든 **새로고침**을 누르면 앱 전체 데이터를 함께 갱신합니다. Pull·삭제·컨테이너 변경 뒤에도 전체 결과를 갱신해 Overview와 상세 화면을 일치시킵니다. 평상시 자동 폴링은 없고, 실행한 작업의 완료 추적과 열어 둔 컨테이너 로그 갱신은 별도로 동작합니다. 갱신 중에도 기존 목록을 유지합니다.

용량은 1,000 기준 KB·MB·GB로 표시합니다. Overview의 **정리 대상 보기**에서 Docker Usage로 이동해 미사용 이미지·빌드 캐시를 선택하고 삭제 내용을 승인할 수 있습니다. Images에는 **Docker Hub 이미지 검색**이 항상 표시됩니다. 검색 버튼으로 결과를 조회하고 이미지를 선택하면 Pull 입력이 열립니다. 태그를 확인한 뒤 Pull을 실행합니다. 검색 영역의 접기·펼치기 상태와 로컬 필터·검색 결과는 메뉴를 이동해도 유지됩니다. 검색은 엔진의 Docker Hub API를 사용하므로 런타임이 중지돼 있으면 이유와 엔진 설정 바로가기를 표시합니다.

**이미지 빌드**에서 Windows의 프로젝트 폴더, 폴더 기준 Dockerfile 경로, 이미지 태그를 지정합니다. `.dockerignore`와 Dockerfile별 ignore 파일은 Buildx가 적용합니다. 기본값은 빌드 캐시를 재사용하며, 필요하면 캐시 없이 빌드할 수 있습니다. 결과는 전용 엔진에 저장됩니다. 같은 태그가 있으면 새 결과를 가리킵니다. 진행 로그는 메뉴 이동 중에도 유지하고, 빌드가 끝나면 전체 화면 데이터를 갱신합니다. 빌드 중에는 엔진 변경·정리·앱 종료를 차단합니다. 최근 로그만 제한된 크기로 보관하고 변경된 경우에만 다시 전달합니다. 진행 중 취소는 아직 지원하지 않습니다.

로컬 이미지 행의 **실행**에서 컨테이너 이름과 선택적인 localhost 포트 연결을 지정하고 **컨테이너 생성 및 실행**을 누릅니다. 생성·시작 뒤 전체 데이터를 갱신하고 Containers의 해당 컨테이너 로그로 이동합니다. 이미지의 기본 명령을 사용하며 hello-world처럼 명령이 끝나면 중지됩니다. Dockerfile에서 새 이미지를 만드는 기능은 상단 **이미지 빌드**와 로컬 목록의 **Dockerfile로 이미지 빌드**에서 엽니다.

실행 설정의 **더보기**에서 Docker 네트워크, 환경 변수, 명령·ENTRYPOINT, 작업 디렉터리, 재시작 정책, 메모리(MB)·CPU 제한을 지정합니다. 네트워크 목록은 더보기를 처음 열 때와 목록 새로고침 시에만 조회합니다. 사용자 bridge 네트워크를 만들면 즉시 선택하고, 내부 전용 설정도 지원합니다. 기본 bridge와 네트워크를 사용하지 않는 none을 선택할 수도 있습니다. none 선택 시 포트 연결을 비웁니다. 환경 변수는 한 줄에 KEY=value, 명령과 ENTRYPOINT는 한 줄에 인수 하나를 입력합니다. 빈 항목은 이미지 기본값을 사용합니다. 생성한 네트워크는 실행 설정을 닫아도 유지됩니다.

메뉴·제목·버튼의 드래그 선택을 막고 입력·로그·표 데이터·경로·진단은 복사할 수 있게 했습니다. Settings는 현재 런타임 상태를 표시하며 중지 완료 후 초록색 성공 알림을 남기지 않습니다.

## 디스크 관리 범위

1. Docker Engine에서 미사용 데이터와 사용량을 조회합니다.
2. 사용자가 선택한 **이미지·빌드 캐시만** 정리하며, 실행 중인 컨테이너·볼륨은 자동 삭제하지 않습니다.
3. WSL 배포판 등록 정보와 실제 파일 시스템에서 DockSlate, Rancher Desktop 및 Docker Desktop의 VHDX를 **각각 식별**합니다. DockSlate는 자체 소유 마커와 등록 ID·경로도 검증합니다.
4. VHDX 압축 전 소유 런타임, 사용·마운트·잠금 상태, 실행 권한과 영향을 받는 WSL 세션을 확인합니다. 사용자의 변경 지시에 따라 백업 생성·경로 입력은 요구하지 않으며, 백업 없이 원본을 변경한다는 점을 승인창에 표시합니다.
5. 안전 조건이 충족되고 사용자가 승인한 경우에만 Windows의 지원되는 압축 기능을 사용합니다. 조건을 확인할 수 없으면 실행을 차단합니다.
6. Docker의 정리 가능 추정치, VHDX 파일 크기, Windows에서 실제 회수한 용량을 **서로 다른 값**으로 표시합니다.

WSL Disks의 **사전 조건 검사**는 해결할 조건을 먼저 표시하고 전체 결과는 **검사 상세 보기**로 접습니다. Windows 내장 Virtual Disk API로 VHDX 형식·분리 상태·식별 정보를 확인하고 `CompactVirtualDisk`를 사용합니다. Hyper-V PowerShell 모듈은 필수 설치 항목이 아닙니다. 내장 API를 사용할 수 없을 때만 지원되는 기존 Optimize-VHD 경로를 확인합니다. **관리자 권한으로 다시 실행**은 Windows 권한 요청과 새 관리자 창을 확인한 뒤 현재 창을 닫습니다. 엔진 상태와 저장된 데이터는 유지되며, 검색과 선택 항목은 초기화됩니다. 실제 압축과 관리자 재실행의 UAC 승인은 아직 검증하지 않았습니다.

`docker_data.vhdx`와 같은 파일은 삭제할 찌꺼기가 아니라 Docker 데이터가 저장된 가상 디스크입니다. 원본 VHDX 직접 삭제와 경로 추측에 의한 조작은 금지합니다.

실제 검증에서는 선택한 빌드 캐시 ID 하나만 삭제하고 선택하지 않은 ID 전부가 유지되는 것을 확인했습니다. VHDX는 탐색·크기 조회와 압축 차단만 확인했으며, 실제 디스크 압축 성공으로 표시하지 않습니다.

## REA 작업 방식

1. 공식 Windows 배포 파일에서 설치 없이 추출하거나, 설치된 Rancher Desktop에서 버전과 실제 Electron 패키지(`app.asar` 또는 배포 디렉터리)를 식별합니다.
2. REA MCP로 모듈 구조, UI↔IPC, 컨테이너 제어, WSL 연동 지점을 조사합니다.
3. REA가 반환한 Evidence와 한계를 기록하고, [Rancher Desktop 공개 소스](https://github.com/rancher-sandbox/rancher-desktop)로 검증합니다.
4. 확인된 동작 중 MVP 기능만 독립적으로 구현합니다.
5. 원본과 DockSlate를 동일한 테스트 환경에서 실행해 결과를 비교합니다.

**REA 분석은 프로젝트의 필수 작업입니다.** 공개 소스만 읽거나 Docker API만 호출한 작업을 REA 역공학 성과로 표시하지 않습니다.

## 개발 시작

Windows용 Node.js/npm, Rust MSVC, Microsoft C++ Build Tools/Windows SDK, WebView2가 필요합니다. 현재 PC에는 승인된 필수 의존성과 빌드 도구, DockSlate 전용 배포판과 엔진을 설치했습니다. Rancher Desktop은 설치하지 않았으며, 이미 설치돼 있던 WSL 2.6.3을 사용합니다.

독립 엔진 설치 위치는 사용자 지정 `D:\Program Files\DockSlate\runtime\wsl`, 배포판 이름은 `DockSlate`입니다. Ubuntu 24.04.5 x64, Docker Engine/CLI 29.8.2, containerd 2.3.6, Buildx 0.38.0, Compose CLI 5.6.0을 고정했으며 rootfs·키·패키지 SHA와 서명된 APT 메타데이터 검증을 포함한 실제 설치를 수행했습니다. curl·iptables·nftables·systemd 및 OS 의존성도 전용 배포판에 설치했습니다. 기존 등록이나 대상 폴더는 덮어쓰지 않습니다. [확인한 설치 입력·운영 제약](docs/results/standalone-runtime-evidence.md), [설치·연결 결과](docs/results/independent-runtime-provisioning.json).

새 PC에서는 Settings에서 대상 확인·설치 승인, 런타임 시작 승인 순으로 진행합니다. 설치된 PC에서는 Settings에서 시작·중지를 승인할 수 있습니다. Linux CLI는 `wsl --distribution DockSlate --user root --exec docker ...` 경로를 사용합니다. Windows 프로젝트 bind mount의 source는 엔진이 보는 `/mnt/<drive>/...` 경로입니다. 이 PC에서는 읽기 전용 Windows 파일 mount와 동적으로 게시한 포트의 Windows localhost HTTP 응답을 실제 검증했습니다. 파일 감시·쓰기 권한·대소문자 동작 전체를 검증한 것은 아닙니다. Windows의 기존 `docker.exe`나 `docker-desktop` context를 독립 엔진으로 간주하지 않습니다.

```powershell
npm install
npm run build
.\node_modules\.bin\vite.cmd preview --host 127.0.0.1 --port 1420 --strictPort
```

위 설치·프런트엔드 빌드·배포 화면 조회는 실제 실행했습니다. 브라우저에서는 Tauri 백엔드가 없다는 오류와 작업 비활성화가 표시됩니다. 모의 데이터나 모의 백엔드는 사용하지 않습니다.

Windows 제품 빌드 및 읽기 전용 진단:

```powershell
.\scripts\desktop.ps1 -Mode build
.\scripts\desktop.ps1 -Mode verify
.\src-tauri\target\release\dockslate.exe
```

프로젝트 내부 `.tools/cargo`와 `.tools/rustup`이 있으면 스크립트가 사용하며, 없으면 설치된 Rust를 사용합니다. 초기 파일 접근 거부 이후 Codex sandbox 밖에서 위 제품 빌드와 진단을 성공했고, 실제 EXE 실행·재실행을 확인했습니다. sandbox 내부 빌드는 재시도에서도 Windows 오류 5로 실패했습니다. 보호 제품·조직 정책 적용 여부와 과거 실패 원인은 미확인이며 보안 설정을 변경하지 않았습니다. `verify`는 지정된 결과 JSON에 읽기 전용 조회와 거부 조건을 기록합니다.

제품 EXE에는 관리 앱과 설치·상태 제어 코드가 포함되며, Ubuntu와 엔진 패키지는 승인된 설치 시 공식 출처에서 다운로드합니다. WebView2와 WSL 2.4.10 이상이 필요합니다. 이전 클라이언트 EXE 크기·실행 검증은 [기존 기록](docs/results/mvp-verification.md)에 남깁니다.

`npm run dev`도 sandbox 밖에서 의존성 변환과 HTTP 응답을 확인했습니다. 분석·도구·Rust·검증 디렉터리를 Vite 파일 감시에서 제외해 잠긴 분석 파일의 EBUSY 종료를 수정했습니다. Tauri 개발 모드(`.\scripts\desktop.ps1 -Mode dev`)는 별도로 검증하지 않았습니다.

[최신 독립 엔진 구현·실행 검증](docs/results/standalone-runtime-verification.md), [기존 클라이언트 검증](docs/results/mvp-verification.md), [추가 구현 근거](docs/results/rea-analysis.md), [세션 REA MCP 호출 감사](docs/results/rea-mcp-call-audit.md)를 참고하세요.

로컬 의존성의 라이선스와 확보한 원문은 [Third-party notices](THIRD_PARTY_NOTICES.md)에 기록했습니다. 누락 원문과 SDK·Rust 표준 라이브러리 고지가 남아 있어 외부 배포 고지는 확정하지 않았습니다.

## MVP 완료 기준

- REA 분석 대상·버전·Evidence·확인되지 않은 사항 기록
- 독립 Moby 엔진 설치·시작·API 연결·중지·재시작 및 컨테이너·이미지 E2E 통과
- Compose 그룹, 로그, 엔진 연결 실패 상태를 실제 데이터로 확인
- Docker 사용량과 Rancher/Docker VHDX의 소유자·경로·크기 구분
- 삭제 확인, 차단 조건, 압축 전제 조건 E2E 검증
- 안전한 테스트 디스크에서 압축 가능 여부 및 작업 전후 용량 검증; 불가한 환경은 미지원으로 명시
- Windows 앱 실행·빌드 검증 및 측정한 크기·메모리 사용량 기록

**분석 상태:** Rancher Desktop 1.24.0 공식 Windows MSI를 설치 없이 추출하고 REA MCP의 집중 정적 분석 결과를 확보했습니다. 전체 ASAR 분석은 시간 제한, 집중 분석은 그래프 자원 제한으로 부분 coverage입니다. [원본 분석 결과·Evidence·미확인 사항](docs/research/rancher-desktop-1.24.0.md)은 보존했습니다. MVP 구현 요청 이후 새 REA MCP 호출은 수행하지 않았습니다.

## 근거 및 참고

- [REA](https://github.com/morluto/rea)
- [Rancher Desktop 아키텍처](https://docs.rancherdesktop.io/references/architecture/)
- [Rancher Desktop 소스 및 Apache-2.0](https://github.com/rancher-sandbox/rancher-desktop)
- [Dockhand](https://github.com/Finsys/dockhand) · [Dockhand 라이선스(BSL 1.1)](https://dockhand.pro/license.html)
- [Docker Engine API](https://docs.docker.com/reference/api/engine/) · [Docker 데이터 정리](https://docs.docker.com/engine/manage-resources/pruning/)
- [Microsoft WSL 디스크 관리](https://learn.microsoft.com/windows/wsl/disk-space)
