# DockSlate

Windows에서 Docker 컨테이너를 관리하는 데스크톱 앱입니다. 전용 WSL 2 엔진을 준비하고, 이미지 다운로드부터 Dockerfile·Compose 빌드와 컨테이너 실행까지 한 화면에서 작업합니다. Docker Desktop을 따로 설치할 필요가 없습니다.

**[공식 웹사이트 · 다운로드](https://seo-gali.github.io/dockslate/)**

## 사용 가이드 영상

[![DockSlate 데모 — YouTube에서 재생](https://i.ytimg.com/vi/EbL7LkbNrPY/hqdefault.jpg)](https://youtu.be/EbL7LkbNrPY)

[▶ YouTube에서 가이드 영상 보기](https://youtu.be/EbL7LkbNrPY)

## 주요 기능

| 작업 | 할 수 있는 일 |
| --- | --- |
| 컨테이너 | 시작·중지, 로그·터미널·파일 확인, 이름·포트·연결 수정 |
| 이미지 | Docker Hub 검색·다운로드, 로컬 이미지 실행·삭제 |
| 빌드 | Dockerfile 이미지 빌드, Compose 프로젝트 빌드·실행 |
| 리소스 | 볼륨·네트워크 관리, Docker 사용량 확인·선택 정리, WSL 디스크 조회 |

외부 터미널에서 실행한 Docker·Compose 변경도 연결된 엔진의 이벤트를 받아 목록에 반영합니다.

## 시작하기

**Windows 11 x64 · WSL 2.4.10 이상 · WebView2**가 필요합니다. 최초 엔진 설치에는 인터넷 연결이 필요합니다.

1. 설치 파일을 실행하고 엔진 준비 화면에서 설치 대상과 영향을 확인해 승인합니다. 포터블은 ZIP 전체를 풀고 `DockSlate.exe`를 실행합니다.
2. **이미지 → Docker Hub**에서 이미지를 검색해 내려받습니다.
3. **로컬 이미지 → 실행**에서 이름·포트·연결을 확인하고 컨테이너를 생성합니다. **컨테이너** 목록의 이름을 누르면 로그·터미널·파일을 확인할 수 있습니다.

포터블의 `bin`·`libexec` 폴더는 실행 파일과 함께 유지하세요. 앱 제거는 전용 WSL 배포판이나 컨테이너·볼륨 데이터를 자동 삭제하지 않습니다.

### Dockerfile·Compose 실행

**빌드 → 파일에서 빌드**에서 Dockerfile 또는 Compose 파일을 선택하면 빌드합니다. Dockerfile로 만든 이미지는 **로컬 이미지 → 실행**에서 실행하고, Compose는 빌드 후 **실행 미리보기**에서 설정을 확인해 실행합니다.

바로 실행해 볼 수 있는 [Node.js 웹 서버 예제](examples/basic-web/README.md)를 제공합니다. `Dockerfile`·`compose.yaml`·`server.mjs`·`.dockerignore`를 같은 폴더에 두고 선택하세요.

### 터미널에서도 사용하기

설치 후 새 PowerShell·CMD에서 Docker CLI를 사용할 수 있습니다. 포터블에서는 `bin\docker.exe`를 실행합니다.

```powershell
docker ps
docker compose version
docker buildx version
```

## 개발

Node.js/npm, Rust MSVC, Microsoft C++ Build Tools와 Windows SDK가 필요합니다.

```powershell
npm ci
.\scripts\desktop.ps1 -Mode dev
```

앱 빌드는 `.\scripts\desktop.ps1 -Mode build`, 사이트 빌드는 `npm run build:site`입니다. [개발·빌드 안내](docs/DEVELOPMENT.md)에서 디렉터리 구성과 패키징 방법을 확인할 수 있습니다.

## 문서와 배포 상태

[문서 안내](docs/README.md)에 상세 사용법, 지원 범위, 배포·보안 상태와 검증 기록을 모았습니다. 현재 배포본은 **0.1.7 미서명 개발 버전**입니다.

Moby 기반 Docker Engine은 엔진 사용료가 없습니다. Docker Hub·컨테이너 이미지·외부 서비스에는 각각의 이용 조건이 적용됩니다. 구성 요소별 조건과 소스 제공은 [타사 라이선스 고지](licenses/THIRD_PARTY_NOTICES.md)를 확인하세요.
