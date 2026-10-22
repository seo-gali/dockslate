# DockSlate

Windows 11 x64용 Docker 관리 앱입니다. 전용 WSL 2의 Docker Engine과 Windows Docker CLI·Compose·Buildx를 함께 준비하고, 컨테이너·이미지·빌드·볼륨·네트워크를 관리합니다.

> **개발 버전 · 미서명.** 이전 브라우징 데이터 접근 경고는 원인 미확인입니다. [서명·보안 상태](docs/results/code-signing.md)

## GitHub Pages 설정

**Settings → Pages → Build and deployment → Source에서 `GitHub Actions`를 선택합니다.** [게시 워크플로](.github/workflows/pages.yml)가 사이트 빌드 결과인 `site-publish/`만 업로드합니다.

Actions는 GitHub 서버에서 작업을 실행하는 기능입니다. **Build Windows installer**는 설치 EXE 제작, **Publish download page**는 사이트 게시 작업입니다. 사이트 게시 때문에 설치 파일을 다시 빌드할 필요는 없습니다. 현재 Pages 워크플로는 수동 실행 방식입니다.

| 용도 | 파일 | 사용하는 방법 |
| --- | --- | --- |
| 공개 사이트 원본 | `site/index.html` | 사이트 빌드에 사용하는 템플릿 |
| 로컬 사이트 미리보기 | `site-dist/index.html` | `npm run build:site` 후 열기 |
| GitHub Pages의 메인 페이지 | `site-publish/index.html` | 게시 워크플로가 생성·업로드 |
| 데스크톱 앱 화면 | 루트 `index.html` → `dist/index.html` | Vite·Tauri가 사용하는 앱 진입점 |
| 로컬 사용 안내서 | `guide.html` | 내려받은 폴더에서 더블클릭해서 보기 |

게시 순서:

1. 검증한 설치 EXE와 ZIP을 GitHub Release `v0.1.0`의 Assets에 등록합니다.
2. 사이트 소스와 게시 워크플로를 기본 브랜치에 반영합니다.
3. Pages의 Source를 **GitHub Actions**로 설정합니다.
4. **Actions → Publish download page → Run workflow**를 실행합니다.

예상 주소는 `https://seo-gali.github.io/dockslate/`입니다. 아직 공개 게시하지 않았습니다. 파일명·해시·게시 조건은 [Pages 안내](docs/PAGES.md)를 확인하세요.

## 설치와 사용

필수 환경: **Windows 11 x64 · WSL 2.4.10 이상 · WebView2**. 엔진 최초 설치에는 인터넷이 필요합니다.

| 형식 | 실행 방법 |
| --- | --- |
| `DockSlate_0.1.0_x64-setup.exe` | 앱·Windows CLI 설치 후, 엔진 준비 대상과 영향을 확인하고 승인 |
| `DockSlate-0.1.0-windows-x64.zip` | 전체 압축 해제 후 `DockSlate.exe` 실행. `bin`·`libexec` 폴더 함께 유지 |

개발 PC의 파일은 `downloads/`에 있으며 Git 저장소에는 포함하지 않습니다. 공개 다운로드는 Release 등록 후 제공됩니다. 이전 [Windows 빌드 산출물](https://github.com/seo-gali/dockslate/actions?query=branch%3Abuild%2Finstaller)은 7일 보관합니다.

설치 후 새 CMD·PowerShell에서 확인합니다.

```powershell
docker ps
docker compose version
docker buildx version
```

앱에서는 **이미지 → 이미지 받기 → 실행 → 컨테이너** 순서로 시작하세요. [사용 안내](USER_GUIDE.md)

## 개발

앱 개발에는 Node.js/npm, Rust MSVC, Microsoft C++ Build Tools·Windows SDK가 필요합니다. 일반 앱 사용자에게 Node.js·Rust는 필요하지 않습니다.

| 작업 | 명령 |
| --- | --- |
| 의존성 준비 | `npm ci` |
| 웹사이트 미리보기 생성 | `npm run build:site` |
| 앱 화면 개발 | `npm run dev` |
| 데스크톱 앱 개발 | `.\scripts\desktop.ps1 -Mode dev` |
| 데스크톱 앱 빌드 | `.\scripts\desktop.ps1 -Mode build` |
| Windows CLI 빌드 | `.\scripts\build-cli.ps1` |
| 포터블 ZIP 생성 | `npm run package:local` |

Windows 구성 요소는 [준비 스크립트](scripts/prepare-windows-docker.ps1)로 고정 해시를 확인합니다. ZIP 생성은 통합 검증 기록과 EXE 해시가 일치해야 합니다. 설치 EXE 제작은 [설치 빌드 스크립트](scripts/build-installer.ps1)를 사용합니다.

## 지원 범위와 검증

- 앱 제거·포터블 폴더 삭제로 WSL 배포판·이미지·볼륨을 자동 삭제하지 않습니다.
- Compose 가져오기는 제한된 구성을 지원합니다. Kubernetes `deployment.yaml` 배포는 지원하지 않습니다.
- 파일 복사 접근 거부와 일부 설치·제거·디스크 압축 검증이 남아 있습니다. 모든 요청이 완료된 상태는 아닙니다.

[요청·검증 현황](docs/REQUEST_STATUS.md) · [Windows CLI 지원 범위](docs/results/windows-cli-contract.md) · [외부 구성 요소 고지](THIRD_PARTY_NOTICES.md)

[작업 지침](AGENTS.md) · [코딩 표준](CODING_STANDARDS.md) · [UI 기준](DESIGN.md)
