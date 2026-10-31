# 개발·빌드와 저장소 구성

Windows 11 x64에서 Node.js/npm, Rust MSVC, Microsoft C++ Build Tools와 Windows SDK를 사용합니다. 의존성 버전은 루트 `package.json`·잠금 파일과 `src-tauri/Cargo.toml`·`Cargo.lock`이 기준입니다.

```powershell
npm ci
.\scripts\desktop.ps1 -Mode dev
```

| 작업 | 명령 |
| --- | --- |
| 앱 빌드 | `.\scripts\desktop.ps1 -Mode build` |
| CLI 빌드 | `.\scripts\build-cli.ps1` |
| 포터블 폴더·ZIP 생성 | `npm run package:local` |
| 사이트 미리보기 | `npm run build:site` → `site-dist/index.html` |

포터블 생성은 현재 버전의 `downloads/DockSlate-<version>-windows-x64/`와 ZIP을 갱신합니다. 앱·CLI 빌드와 `docs/results/installer-engine-integration.json`의 검증 해시가 일치해야 합니다. EXE 하나만 복사하면 동봉 CLI·플러그인이 빠질 수 있습니다. 설치 파일 생성과 내부 파일 검증은 [배포 기록](results/installer-engine-integration.json)을 따릅니다.

작업 브랜치는 `main`입니다. 로컬 빌드와 사이트 생성은 외부 게시가 아니며, 푸시·배포·의존성 변경은 별도 승인 범위에서 수행합니다.

## 디렉터리

| 위치 | 역할 |
| --- | --- |
| `src/` · `src-tauri/` | 데스크톱 UI와 Windows·Docker 백엔드 |
| `scripts/` | 빌드·검증 도구. 수동 실행 도구도 있으므로 import가 없다는 이유만으로 삭제하지 않음 |
| `site/` | 공개 사이트의 HTML 템플릿·스타일·스크립트 |
| `docs/` | 개발·검증·조사 문서와 보존할 고지 ZIP. 사이트 사본은 생성하지 않음 |
| `downloads/` | 배포 파일. 이전 패키지가 참조하는 고지 ZIP은 앱 구버전 삭제와 구분 |
| `licenses/` | 배포에 필요한 고지·소스와 구성 요소 목록 |
| `.analysis/` | 로컬 조사·검증 자료. 원본·진행 중 자료를 확인한 뒤 임시 사본을 정리 |
| `dist/` · `site-dist/` | 각각 앱·사이트 빌드 결과. 원본이 아니며 다시 생성 가능 |

`src/`는 앱 화면, `src-tauri/`는 Windows 백엔드, `site/`는 공개 웹사이트이므로 서로 중복이 아니다. `src-tauri/target/`에는 네이티브 빌드 결과와 검증한 도구 캐시가 있으며 소스와 구분한다.

## 루트에 남겨야 하는 파일

`package.json`·`package-lock.json`·`tsconfig.json`·`vite.config.ts`는 현재 도구 설정의 진입점입니다. `AGENTS.md`는 작업 지침 탐색, `README.md`는 저장소 첫 화면에 사용합니다.

GitHub Pages는 `Deploy from a branch` → `main` → `/(root)`로 설정합니다. 루트 `index.html`·`404.html`·`robots.txt`·`sitemap.xml`·`.nojekyll`·Google 확인 HTML은 이 게시 방식에서 사용하므로 임의로 옮기지 않습니다. 원본은 `site/`, 생성 명령은 `npm run build:site -- --publish`입니다. [상세](PAGES.md).

코딩·디자인 기준을 `docs/`로 옮겨 루트 파일을 19개에서 17개로 줄였습니다. 사용자 안내와 타사 고지는 기존 패키징·배포 경로를 유지합니다. 지침의 의미 변경은 별도 제안이며 이번 이동에서는 링크 경로만 수정했습니다. [작업 지침](../AGENTS.md) · [코딩 기준](CODING_STANDARDS.md) · [UI 기준](DESIGN.md).
