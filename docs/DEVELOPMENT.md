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
| `media/` | 로컬 영상·원고·자막. Git 제외 대상이며 README에는 공개 영상 링크만 사용 |
| `dist/` · `site-dist/` | 각각 앱·사이트 빌드 결과. 원본이 아니며 다시 생성 가능 |

`src/`는 앱 화면, `src-tauri/`는 Windows 백엔드, `site/`는 공개 웹사이트이므로 서로 중복이 아니다. `src-tauri/target/`에는 네이티브 빌드 결과와 검증한 도구 캐시가 있으며 소스와 구분한다.

## 루트와 문서 배치

`package.json`·`package-lock.json`·`tsconfig.json`·`vite.config.ts`는 현재 도구 설정의 진입점입니다. `AGENTS.md`는 작업 지침 탐색, `README.md`는 저장소 첫 화면에 사용합니다.

루트에는 위 진입점과 `.gitattributes`·`.gitignore`만 둡니다. 사이트 원본은 `site/`, 사용 안내는 `docs/USER_GUIDE.md`, 타사 고지는 `licenses/THIRD_PARTY_NOTICES.md`에 둡니다. `npm run build:site`는 `site-dist/`만 갱신하고, GitHub Pages는 Actions에서 이 결과를 게시합니다. [게시 설정](PAGES.md).

앱·포터블 빌드는 `site/guide.html`을 패키지의 `guide.html`로 복사합니다. Markdown 안내는 `docs/USER_GUIDE.md`, 고지는 `licenses/`에 포함합니다. 소스를 옮길 때는 이 패키징 경로도 함께 수정합니다. 최신 재패키징은 정리된 경로와 최적화한 실행 파일을 설치 EXE·ZIP에 반영합니다. 배포 파일의 실제 검사 범위는 [배포 기록](results/installer-engine-integration.json)에서 확인합니다.

개발·코딩·디자인 문서는 `docs/`, 실제 실행 결과와 과거 버전 기록은 `docs/results/`에 둡니다. 과거 실행 파일 경로나 미검증 표시는 당시 기록이며 현재 상태는 [요청 현황](REQUEST_STATUS.md)과 최신 결과를 확인합니다.

`.analysis`를 정리할 때는 사용 중인 프로필·파일 잠금·Git 작업 사본·조사 원본을 먼저 확인합니다. 비활성 테스트 브라우저와 압축 해제 사본은 정리할 수 있지만 라이선스 소스·보안 조사 원본·실제 WSL VHDX·소유권 메타데이터는 임시 캐시로 취급하지 않습니다. `media/`의 완성 영상은 정리 대상과 구분합니다.

[작업 지침](../AGENTS.md) · [코딩 기준](CODING_STANDARDS.md) · [UI 기준](DESIGN.md)
