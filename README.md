# DockSlate

Windows 11용 컨테이너 관리 앱. Docker Desktop 대신 전용 WSL 2 Moby 엔진을 사용합니다.

**현재 상태: 개발 버전. 요청 전체가 검증 완료된 상태는 아닙니다.**

## 실행 · 다운로드

| 찾는 것 | 파일 |
| --- | --- |
| 다운로드와 사용 안내 | **[guide.html](guide.html)** — 더블클릭해서 열기 |
| 바로 실행할 EXE | [downloads/DockSlate.exe](downloads/DockSlate.exe) |
| 안내서가 포함된 ZIP | [DockSlate-0.1.0-windows-x64.zip](downloads/DockSlate-0.1.0-windows-x64.zip) |
| 설치 방식 | 사용자 선택에 따라 설치 없이 쓰는 EXE·ZIP 제공 |
| 요청별 구현·검증 상태 | [체크리스트](docs/REQUEST_STATUS.md) |

`downloads`는 로컬 빌드 결과라 Git 저장소에 포함하지 않습니다. 소스만 내려받았다면 아래 빌드 절차로 생성하세요. 온라인 배포 링크는 아직 없습니다.

1. ZIP을 풀고 `DockSlate.exe`를 실행합니다.
2. **설정 → 런타임**에서 설치 대상 확인·승인 후 엔진을 시작합니다.
3. **Images**에서 이미지를 준비하고 컨테이너를 실행합니다.

필수 환경: Windows 11 x64, WSL 2.4.10 이상, WebView2. Node.js·Rust는 앱 사용자에게 필요하지 않습니다. 엔진 최초 설치에는 인터넷이 필요합니다.

> **보안 확인 미완료:** EXE는 서명되지 않았습니다. 브라우징 데이터 접근 경고의 원인은 미확인입니다. 사용자가 지정 EXE 실행을 명시적으로 승인한 뒤 새 프로필에서 검증했으며, 보안 예외·신뢰 등록은 하지 않았습니다. [확인한 내용](docs/results/browsing-data-alert.md)

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
| 최신 Windows EXE 빌드·TypeScript·Rust 검사 | 통과. [빌드 기록](docs/results/refinement-build.json) |
| 최신 EXE의 실제 화면·로그 | Pull·실행·접속 주소 9개, 로그 이벤트 13개, 상세·로그 화면 5개 통과. [범위](docs/results/interaction-workflows.md) |
| 최신 배포 화면 | 9개 통과. 언어·설정 탭·지연 로딩·상태 보존. [결과](docs/results/frontend-refinements-e2e.json) |
| 이전 EXE의 화면·리소스 동작 | 25개 통과. 최신 변경 전체를 검증한 결과는 아님. [범위](docs/results/refinement-verification.md) |
| 독립 엔진 설치·컨테이너·포트·파일 마운트 | 이전 실제 환경 검증 통과. [결과](docs/results/standalone-runtime-verification.md) |
| 성능 변경 | 진입 JS 약 497→277KB. 메뉴·번역 지연 로딩, 공유 요청·제한 캐시. [측정 범위](docs/results/refinement-verification.md) |

**남은 검증:** 실행 중 서버의 시작·중지 전환, 인라인 볼륨 연결, Dockerfile·Compose 파일 선택→빌드→실행, 복사한 실행 명령, 실제 VHDX 압축·UAC. 보안 경고도 미해결입니다.

## 소스에서 빌드

개발 도구: Node.js/npm, Rust MSVC, Microsoft C++ Build Tools/Windows SDK. 프로젝트의 `.tools`에 설치된 Rust가 있으면 스크립트가 사용합니다.

```powershell
npm ci
.\scripts\desktop.ps1 -Mode build
npm run package:local
```

결과: `downloads/DockSlate.exe`, `downloads/DockSlate-0.1.0-windows-x64.zip`. 패키징은 앱을 실행하거나 WSL을 변경하지 않습니다.

별도 설치 프로그램은 만들지 않습니다. 사용자가 추가 도구 없이 EXE·ZIP 배포를 선택했습니다.

브라우저 화면 개발: `npm run dev`. 데스크톱 개발: `.\scripts\desktop.ps1 -Mode dev`. 브라우저에는 네이티브 백엔드가 없으므로 엔진 작업을 실행할 수 없습니다.

## 데이터 · 지원 범위

- 앱과 전용 WSL 배포판은 별개입니다. 앱 제거·EXE 삭제로 이미지·볼륨을 자동 삭제하지 않습니다.
- 기존 컨테이너의 볼륨 변경은 재생성이 필요합니다. 볼륨 생성만으로 자동 연결되지 않습니다.
- Compose 가져오기는 제한된 로컬 프로젝트만 지원합니다. Kubernetes `deployment.yaml` 배포는 지원하지 않습니다.
- 실행 중 컨테이너·볼륨을 자동 정리하지 않습니다. 압축은 조건 검사와 승인이 필요합니다.
- Apple container는 macOS용입니다. Windows 엔진 대체로 적용하지 않았습니다.
- Windows에는 `docker.exe`를 설치하지 않습니다. CMD·PowerShell에서는 `wsl -d DockSlate -u root --exec docker --host unix:///var/run/docker.sock ps`로 전용 CLI를 호출합니다.

[작업 지침](AGENTS.md) · [코딩 표준](CODING_STANDARDS.md) · [UI 기준](DESIGN.md)

[사용 안내](guide.html) · [요청 체크리스트](docs/REQUEST_STATUS.md) · [Rancher Desktop REA 근거](docs/research/rancher-desktop-1.24.0.md) · [외부 라이선스 고지와 미확인 항목](THIRD_PARTY_NOTICES.md)
