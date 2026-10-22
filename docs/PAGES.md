# GitHub Pages

공개 주소: [seo-gali.github.io/dockslate](https://seo-gali.github.io/dockslate/)

## 게시 설정

**Settings → Pages → Source: Deploy from a branch → Branch: main → Folder: /(root) → Save**

`main` 하나에서 작업하고, 루트 `index.html`과 `site` 자산·안내서·Google 확인 파일을 함께 커밋한다.

| 파일 | 역할 |
| --- | --- |
| `site/index.html` · `site/styles.css` · `site/main.js` | 웹사이트 원본 |
| 루트 `index.html` | 공개 소개·다운로드 메인 |
| `guide.html` | 설치·사용 순서 |
| `google474f5421d7424578.html` | Google 소유권 확인 원문 |
| `site-dist/index.html` | 실제 로컬 파일을 내려받는 미리보기 |
| `src/index.html` → `dist/index.html` | 데스크톱 앱 화면. Vite 개발 서버와 Tauri 빌드에서 사용 |

## 업데이트

```powershell
npm run build:site
npm run build:site -- --publish
```

첫 명령은 로컬 EXE·ZIP의 크기·SHA-256을 확인하고 `site-dist`를 생성한다. 두 번째는 같은 검증을 거쳐 루트 메인과 기존 `/docs` 게시본을 함께 갱신하고 실행 파일을 포함한다. 기존 `/docs` 게시 설정에서도 같은 사이트가 보이도록 유지하며 Markdown·이미지는 삭제하지 않는다.

파일이 없거나 크기·SHA-256이 다르면 사이트 생성을 중단한다. 빌드한 HTML·자산·실행 파일을 `main`에 함께 커밋·푸시한다. 빌드 자체는 공개 설정을 바꾸거나 파일을 전송하지 않는다.

엔진 사용료와 라이선스 범위는 FAQ에 표시하고 최신 `THIRD_PARTY_NOTICES.md`를 실행 파일 옆에 제공한다. 기존 EXE·ZIP은 다시 만들지 않으며, 이후 패키징에서는 현재 고지와 독립 안내서를 그대로 복사한다. 하위 의존성까지 배포 조건 검토를 완료했다는 의미는 아니다.

## 실행 파일

`site/release.json`의 버전·파일명·크기·SHA-256이 기준이다. 검증한 설치 EXE와 ZIP을 루트 `downloads/`에 포함하고 기존 게시 폴더에도 같은 파일을 복사한다. 두 경로의 동일 파일은 Git에서 같은 blob을 사용한다. 현재 파일은 미서명이며 이전 브라우징 데이터 접근 경고의 원인은 미확인이다.

다운로드 주소:

- [설치 EXE](https://seo-gali.github.io/dockslate/downloads/DockSlate_0.1.0_x64-setup.exe)
- [포터블 ZIP](https://seo-gali.github.io/dockslate/downloads/DockSlate-0.1.0-windows-x64.zip)

설치 EXE 제작은 로컬 `scripts/build-installer.ps1`, 포터블 ZIP 생성은 `npm run package:local`을 사용한다. GitHub에서 설치 파일을 자동 제작하지 않는다.

## 화면과 검증

[사이트 데스크톱](assets/site-desktop.png) · [사이트 모바일](assets/site-mobile.png) · [안내서](assets/guide-desktop.png) · [구성도](assets/architecture.svg)

README의 [프로그램 캡처](assets/dockslate-disk.png)는 [B66E9FE7 실제 Windows 앱 검증](results/table-layout.md) 당시 화면이다. 웹페이지 작업 때문에 EXE·엔진을 다시 실행하지 않는다.

검증 기록: [사이트](results/pages-e2e.json) · [로컬 안내서](results/guide-delivery-e2e.json) · [실제 공개 URL](results/public-pages-e2e.json). 공개 URL 확인과 로컬 브라우저 검증은 구분해 기록한다.

최종 확인: `npm run build`, `npm run build:site`, `npm run build:site -- --publish` 종료 0. 사이트의 실제 Chrome 검사 24개와 독립 사용 안내서 검사 8개 통과. 루트·기존 게시 폴더의 EXE·ZIP 실제 HTTP 응답과 크기·SHA-256 일치, 최신 고지 파일·직접 사용 안내·Google 원문·분리한 React 앱 렌더링을 확인했다. 실제 Vite 개발 서버도 src 앱 HTML·변환한 main.tsx·React 의존성 3개를 HTTP 200으로 제공하고 정상 종료했다.

공개 사이트도 새 격리 Chrome에서 9개 검사를 통과했다. EXE·ZIP 버튼으로 실제 다운로드한 파일의 크기·SHA-256, 최신 고지 원문, Google 확인 파일 HTTP 200, 안내서 왕복, PC·모바일 레이아웃을 확인했다. 위 사이트·안내서 캡처는 이 공개 URL에서 저장했다. EXE 실행·설치나 Linux 패키지의 라이선스 검토를 수행한 결과는 아니다.

[GitHub Pages 게시 방식](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
