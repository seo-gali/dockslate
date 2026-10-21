# DockSlate

Windows 11용 Docker Engine 관리 앱. Docker Desktop처럼 앱·내부 Linux 엔진·Windows Docker 명령을 함께 준비합니다. Linux 엔진은 DockSlate 전용 WSL 2에서 실행하며 기존 데이터는 유지합니다.

**현재 상태: 개발 버전. 요청 전체가 검증 완료된 상태는 아닙니다.**

공식 Windows Docker CLI·Compose·Buildx를 포함한 포터블 ZIP을 만들었습니다. 실제 엔진 연결·한글 경로 연결·입출력·로그 취소·Compose 실행을 확인했습니다. 파일 복사는 접근 거부로, NSIS 설치판 제작은 입력 파일 읽기 오류로 실패했습니다. [현재 결과](docs/results/installation-correction.md), [Docker Desktop 조사](docs/research/docker-desktop-4.96.0.md)

## 실행 · 다운로드

| 찾는 것 | 파일 |
| --- | --- |
| 다운로드와 사용 안내 | **[guide.html](guide.html)** — 더블클릭해서 열기 |
| 앱·CLI·플러그인·안내서가 포함된 ZIP | [DockSlate-0.1.0-windows-x64.zip](downloads/DockSlate-0.1.0-windows-x64.zip) — 압축을 풀고 폴더 안의 DockSlate.exe 실행 |
| 설치판 | 미생성 — NSIS 컴파일 오류 해결·설치 검증 필요 |
| 요청별 구현·검증 상태 | [체크리스트](docs/REQUEST_STATUS.md) |

`downloads`는 로컬 빌드 결과라 Git 저장소에 포함하지 않습니다. 소스만 내려받았다면 아래 빌드 절차로 생성하세요. 온라인 배포 링크는 아직 없습니다.

1. 설치판은 앱·Windows CLI를 복사하고 Docker Engine 설치 대상을 자동으로 확인합니다. 포터블은 ZIP을 풀고 EXE를 실행합니다.
2. **Docker Engine 설치 및 시작**의 대상과 영향을 확인하고 동의하면 다운로드·설치·시작을 이어서 진행합니다. 기존 엔진은 소유권을 확인해 재사용하고, 중지 상태면 시작합니다. WSL을 삭제할 필요는 없습니다.
3. 설치판은 엔진·Windows CLI·Compose·Buildx를 자동으로 확인한 뒤 설치창으로 돌아갑니다. 새 터미널에서 `docker ps`, `docker compose version`을 사용할 수 있게 하는 것이 완료 조건입니다. 이 설치 흐름의 실제 설치 검증은 아직 남아 있습니다.
4. DockSlate의 **Images**에서 이미지를 준비하고 컨테이너를 실행합니다.

필수 환경: Windows 11 x64, WSL 2.4.10 이상, WebView2. Node.js·Rust는 앱 사용자에게 필요하지 않습니다. 엔진 최초 설치에는 인터넷이 필요합니다.

> **보안 확인 미완료:** EXE는 서명되지 않았습니다. 이전 브라우징 데이터 접근 경고의 원인은 미확인입니다. 새 후보의 CLI 검사는 별도 승인과 격리 프로필로 수행했습니다. 보안 예외·신뢰 등록은 하지 않았습니다. [확인한 내용](docs/results/browsing-data-alert.md)

`index.html`과 `dist/index.html`은 앱 화면의 진입점입니다. 파일로 열면 실행·사용 안내가 표시됩니다. 엔진 관리는 Windows EXE에서 동작합니다.

## 메뉴

| 메뉴 | 주요 기능 |
| --- | --- |
| Overview | 엔진·컨테이너·이미지·디스크 요약 |
| Containers | 너비 조절 표, 접속 주소 복사, 중앙 상세·통계·실시간 로그 스트림·파일 트리 |
| Images | Docker Hub 검색·Pull 진행 팝업, 행 아래 실행 설정, 명령 미리보기, 삭제 승인 |
| Resources | 볼륨·네트워크 탭, 생성·참조 확인·삭제, 볼륨 파일·tar 전송 |
| Builds | Dockerfile·Compose 가져오기, 빌드·기록·빌더 관리 |
| Disk Manager | 선택한 이미지·캐시 정리, WSL 디스크 식별·압축 조건 확인 |
| Settings | 한국어/영어, 다크/라이트, 글자 크기, 런타임·연결 탭 |

## 검증 상태

| 확인한 범위 | 결과 |
| --- | --- |
| 현재 소스의 Windows EXE·CLI 빌드·TypeScript·Rust 검사 | 통과. 설치판 제작은 파일 접근 오류로 실패. [현재 기록](docs/results/installer-engine-integration.json) |
| 새 Windows CLI와 기존 소유 엔진 | 실제 명령 34개 중 32개 성공, 파일 복사 2개 접근 거부로 실패. 로그 취소 후 잠금 해제 통과. 검증 리소스 정리·기존 ID 보존·엔진 중지 복원 확인. [결과](docs/results/native-cli-connection.json) |
| 배포 중 EXE의 실제 화면·로그 | Pull·실행·접속 주소 9개, 로그 이벤트 13개, 상세·로그 화면 5개 통과. 새 설치 통합 후보의 검증은 아님. [범위](docs/results/interaction-workflows.md) |
| 최신 배포 프런트엔드 | 브라우저 검사 10개 통과. 언어·탭 유지·상세 코드 지연 로딩. 엔진 미연결 환경. [결과](docs/results/api-performance-browser.json) |
| 이전 EXE의 화면·리소스 동작 | 25개 통과. 최신 변경 전체를 검증한 결과는 아님. [범위](docs/results/refinement-verification.md) |
| 독립 엔진 설치·컨테이너·포트·파일 마운트 | 이전 실제 환경 검증 통과. [결과](docs/results/standalone-runtime-verification.md) |
| 성능 변경 | 진입 JS 278.6→268.9KB, 컨테이너 목록 JS 55.7→26.4KB. 50행 표시·상세 지연 로딩·중복 요청 공유·제한 캐시. [측정·한계](docs/results/api-performance.md) |

**남은 검증:** 실행 중 서버의 시작·중지 전환, 인라인 볼륨 연결, Dockerfile·Compose 파일 선택→빌드→실행, 복사한 실행 명령, 실제 VHDX 압축·UAC. 보안 경고도 미해결입니다.

## 소스에서 빌드

개발 도구: Node.js/npm, Rust MSVC, Microsoft C++ Build Tools/Windows SDK. 프로젝트의 `.tools`에 설치된 Rust가 있으면 스크립트가 사용합니다.

```powershell
npm ci
.\scripts\prepare-windows-docker.ps1
.\scripts\desktop.ps1 -Mode build
.\scripts\build-cli.ps1
npm run package:local
```

결과: `downloads/DockSlate-0.1.0-windows-x64.zip` 안에 앱·bin·libexec를 함께 포함합니다. 기존 단독 EXE 다운로드는 갱신하지 않습니다. 패키징은 앱을 실행하거나 WSL을 변경하지 않습니다.

Windows 구성 준비는 기본 오프라인 검사입니다. 승인한 공식 배포본과 고정 해시가 캐시에 있어야 합니다. 최초 다운로드와 CLI ZIP의 SHA-256 고정 절차는 [준비 스크립트](scripts/prepare-windows-docker.ps1), [구성 manifest](scripts/windows-docker.manifest.json)를 확인하세요.

설치판 제작은 `scripts/build-installer.ps1`을 사용합니다. 공식 NSIS 도구는 사용자 승인 후 캐시했습니다. 설치판은 현재 사용자 PATH에 `bin`을 등록하며 앱 제거 시 엔진·WSL 데이터를 삭제하지 않습니다. 최초 엔진 설치는 온라인 방식입니다.

브라우저 화면 개발: `npm run dev`. 데스크톱 개발: `.\scripts\desktop.ps1 -Mode dev`. 브라우저에는 네이티브 백엔드가 없으므로 엔진 작업을 실행할 수 없습니다.

## 데이터 · 지원 범위

- 앱과 전용 WSL 배포판은 별개입니다. 앱 제거·EXE 삭제로 이미지·볼륨을 자동 삭제하지 않습니다.
- 기존 컨테이너의 볼륨 변경은 재생성이 필요합니다. 볼륨 생성만으로 자동 연결되지 않습니다.
- Compose 가져오기는 제한된 로컬 프로젝트만 지원합니다. Kubernetes `deployment.yaml` 배포는 지원하지 않습니다.
- 실행 중 컨테이너·볼륨을 자동 정리하지 않습니다. 압축은 조건 검사와 승인이 필요합니다.
- Apple container는 macOS용입니다. Windows 엔진 대체로 적용하지 않았습니다.
- 새 설치 구성은 공식 Windows Docker CLI·Compose·Buildx와 사용자 전용 named pipe를 포함합니다. Windows에서 파일과 환경 변수를 처리하고 기존 소유 Linux 엔진에 연결합니다. 구성 요소를 함께 담은 설치판·포터블 ZIP이 필요합니다. 기존 엔진의 CLI·Compose 실행은 확인했지만 실제 설치와 파일 복사·빌드는 검증이 남아 있습니다. [지원 범위와 미검증 항목](docs/results/windows-cli-contract.md)

[작업 지침](AGENTS.md) · [코딩 표준](CODING_STANDARDS.md) · [UI 기준](DESIGN.md)

[사용 안내](guide.html) · [요청 체크리스트](docs/REQUEST_STATUS.md) · [Rancher Desktop REA 근거](docs/research/rancher-desktop-1.24.0.md) · [외부 라이선스 고지와 미확인 항목](THIRD_PARTY_NOTICES.md)
