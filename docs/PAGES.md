# GitHub Pages

공개 주소: [seo-gali.github.io/dockslate](https://seo-gali.github.io/dockslate/)

## 게시 설정

**Settings → Pages → Source: Deploy from a branch → Branch: main → Folder: /docs → Save**

`main` 하나에서 작업하고, 빌드한 `docs/index.html`과 CSS·JS·안내서·Google 확인 파일을 함께 커밋한다. 별도 Actions 워크플로는 사용하지 않는다. GitHub Pages 자체의 자동 배포 이력은 Actions 화면에 표시될 수 있다.

| 파일 | 역할 |
| --- | --- |
| `site/index.html` · `site/styles.css` · `site/main.js` | 웹사이트 원본 |
| `docs/index.html` | Pages에 게시하는 메인 페이지 |
| `docs/guide.html` | 공개 사용 안내서 |
| `docs/google474f5421d7424578.html` | Google 소유권 확인 원문 |
| `site-dist/index.html` | 실제 로컬 파일을 내려받는 미리보기 |
| 루트 `index.html` · `dist/index.html` | 데스크톱 앱 화면. Pages 게시 대상으로 선택하지 않음 |

## 업데이트

```powershell
npm run build:site
npm run build:site -- --publish
```

첫 명령은 로컬 EXE·ZIP의 크기·SHA-256을 확인하고 `site-dist`를 생성한다. 두 번째는 공개 Release 파일을 실제로 확인한 뒤 `/docs`의 사이트 파일만 갱신한다. 기존 Markdown·이미지는 삭제하지 않는다.

공개 Release 파일이 아직 없으면 해당 버튼을 비활성화한 채 사이트를 생성한다. 다른 HTTP 오류·전송 오류·해시 불일치는 실패로 처리한다. 파일을 올린 뒤 다시 빌드하고 `main`에 커밋·푸시하면 다운로드가 활성화된다. 빌드 자체는 공개 설정을 바꾸거나 파일을 전송하지 않는다.

## 실행 파일

`site/release.json`의 버전·파일명·크기·SHA-256이 기준이다. 검증한 설치 EXE와 ZIP을 GitHub Release `v0.1.0`의 Assets에 같은 이름으로 등록한다. 현재 파일은 미서명이며 이전 브라우징 데이터 접근 경고의 원인은 미확인이다.

설치 EXE 제작은 로컬 `scripts/build-installer.ps1`, 포터블 ZIP 생성은 `npm run package:local`을 사용한다. GitHub에서 설치 파일을 자동 제작하지 않는다.

## 브랜치 보호 알림

`Your main branch isn't protected`는 Actions 실패가 아니라 GitHub의 보호 설정 안내다. 규칙을 만들지 않으려면 **Dismiss**를 누른다. 소스 코드나 워크플로 파일을 지워 이 알림을 숨길 수는 없다. 이 작업에서는 보호 규칙·PR·상태 검사 요구 조건을 추가하지 않는다.

## 화면과 검증

[사이트 데스크톱](assets/site-desktop.png) · [사이트 모바일](assets/site-mobile.png) · [안내서](assets/guide-desktop.png) · [구성도](assets/architecture.svg)

README의 [프로그램 캡처](assets/dockslate-disk.png)는 [B66E9FE7 실제 Windows 앱 검증](results/table-layout.md) 당시 화면이다. 웹페이지 작업 때문에 EXE·엔진을 다시 실행하지 않는다.

검증 기록: [사이트](results/pages-e2e.json) · [로컬 안내서](results/guide-delivery-e2e.json). 공개 URL 확인과 로컬 브라우저 검증은 구분해 기록한다.

최종 확인: `npm run build`, `npm run build:site`, `npm run build:site -- --publish` 종료 0. 사이트의 실제 Chrome 검사 19개와 로컬 안내서 검사 12개 통과. 공개 Release 0건에 대응하는 비활성 버튼과 Google 파일 원문을 정적 `/docs` 출력에서도 확인했다. 기존 앱·이미지·문서는 보존했고 워크플로 YAML 2개만 제거했다.

[GitHub Pages 게시 방식](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) · [브랜치 보호](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
