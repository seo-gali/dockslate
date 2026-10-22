# GitHub Pages 다운로드 페이지

프로젝트 소개·설치 EXE·포터블 ZIP·사용 방법을 제공하는 정적 페이지다. 데스크톱 앱의 Vite 진입점과 분리하며 Node 내장 기능만으로 빌드한다.

## 로컬 확인

```powershell
npm run build:site
```

`site-dist/index.html`을 열면 실제 로컬 EXE·ZIP을 다운로드할 수 있다. 원본은 `site/index.html`, `site/styles.css`, `site/main.js`다. 버전·파일명·크기·SHA-256은 `site/release.json` 한 곳에서 관리한다. 빌드는 원본 파일 해시가 다르면 실패한다.

`site-dist`는 미리보기 결과물이며 Git에 넣지 않는다. 기존 `guide.html`과 데스크톱 앱의 빌드·실행 방식은 그대로다.

## 공개 게시 준비

예상 주소는 `https://seo-gali.github.io/dockslate/`다. 현재 주소가 게시됐다는 의미는 아니다.

1. `site/release.json`에 고정한 EXE와 ZIP을 GitHub Release `v0.1.0`의 Assets에 같은 파일명으로 올린다. 미서명 개발 버전임을 Release 본문에도 표시한다.
2. 사이트 소스·워크플로를 검토한 뒤 기본 브랜치에 반영한다. Pages 워크플로는 자동 게시하지 않고 수동 실행만 허용한다.
3. 저장소 **Settings → Pages → Source → GitHub Actions**를 선택한다.
4. **Actions → Publish download page → Run workflow**를 실행한다. 공식 Release 파일을 실제로 내려받아 SHA-256을 확인한 뒤 정적 파일만 Pages에 게시한다. 원본 EXE·ZIP은 Releases에서 제공한다.

게시 전 검사:

```powershell
npm run build:site -- --publish
```

공개 Release 파일이 없거나 해시가 다르면 실패한다. 미리보기 `site-dist`는 보존하며, 공개용 출력은 `site-publish`에 따로 만든다. 페이지가 게시되지 않았는데 다운로드가 된 것처럼 표시하지 않는다.

## 승인 범위

워크플로는 기존 checkout·setup-node에 공식 configure-pages·upload-pages-artifact·deploy-pages를 추가하며 커밋 SHA로 고정한다. 실행에는 `pages: write`, `id-token: write`가 필요하다. Release 파일 공개·기본 브랜치 반영·Pages 활성화·배포는 실제 실행 전 사용자 승인을 받는다. 토큰 내용을 읽거나 저장하지 않는다.

## 검증 결과

| 명령·확인 | 실제 결과 |
| --- | --- |
| `npm run build:site` 구현 전 | 종료 1, 빌드 스크립트 없음 확인 |
| `npm run build:site` 구현 후 | 종료 0, 실제 파일 2개의 크기·SHA-256 확인 후 미리보기 생성 |
| `npm run build:site -- --publish` | 종료 1, 공개 Release 파일의 실제 404를 감지. 깨진 공개 링크를 가진 사이트 출력·배포 없음 |
| `node scripts/verify-site.mjs .analysis/site-browser-session.json` | 종료 0, 격리한 실제 Chrome 검사 16개 통과. [결과](results/pages-e2e.json) |
| 실제 브라우저 | 로컬 HTML·/dockslate/ 하위 경로·4개 사용법 탭·화살표/Home/End·명령어 클립보드·FAQ 클릭/Enter·EXE/ZIP 실제 다운로드와 원본 해시 일치 |
| 반응형·접근성 | 1440·1024·390px에서 해시를 펼쳐도 가로 넘침 없음. 모션 축소 설정·JavaScript 비활성 상태에서도 다운로드/전체 안내 확인 |
| 시각 확인 | 데스크톱·모바일 실제 캡처 확인. HTML·CSS·JS·자체 로고 합계 33,582바이트. 외부 폰트·래스터 이미지·추적 스크립트 없음 |

Windows 클립보드의 CRLF 줄바꿈과 Enter 키 문자 입력을 테스트에 반영한 뒤 최종 검사를 통과했다. 신규 npm 의존성·패키지 버전·lock 변경 및 삭제 파일은 없다.

공개 Release 업로드·기본 브랜치 변경·Pages 활성화·배포는 실행하지 않았다. 실제 게시 URL과 공개 다운로드의 성공 검증은 파일 등록 후에 수행해야 한다. 앱·설치판·엔진은 실행하지 않았다.

공개 페이지는 앱의 안전성 인증이 아니다. 현재 파일은 미서명이며 이전 브라우징 데이터 접근 경고의 원인은 미확인이다.

[GitHub Pages 공식 워크플로 안내](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) · [GitHub Release 다운로드 링크](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)
