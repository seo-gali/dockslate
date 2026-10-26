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
| `sitemap.xml` · `robots.txt` · `404.html` | 빌드에서 생성하는 검색·오류 페이지 |
| `site-dist/index.html` | 실제 로컬 파일을 내려받는 미리보기 |
| `src/index.html` → `dist/index.html` | 데스크톱 앱 화면. Vite 개발 서버와 Tauri 빌드에서 사용 |

## 업데이트

```powershell
npm run build:site
npm run build:site -- --publish
```

첫 명령은 로컬 EXE·ZIP의 크기·SHA-256을 확인하고 `site-dist`를 생성한다. 두 번째는 같은 검증을 거쳐 루트 메인과 기존 `/docs` 게시본을 함께 갱신하고 실행 파일을 포함한다. 기존 `/docs` 게시 설정에서도 같은 사이트가 보이도록 유지하며 Markdown·이미지는 삭제하지 않는다.

파일이 없거나 크기·SHA-256이 다르면 사이트 생성을 중단한다. 빌드한 HTML·자산·실행 파일을 `main`에 함께 커밋·푸시한다. 빌드 자체는 공개 설정을 바꾸거나 파일을 전송하지 않는다.

## 검색 색인

GitHub Pages의 [정적 호스팅 방식](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)을 유지한다. 공개 사이트는 React 앱의 CSR 진입점과 분리되어 있으며, 빌드한 HTML에 다운로드·기능·안내 본문이 들어간다. 요청 시 실행하는 SSR 서버를 추가하지 않는다. JavaScript를 꺼도 본문과 링크가 제공되는지 검사한다.

- `build:site`가 공개 페이지 목록에서 [Sitemap](https://seo-gali.github.io/dockslate/sitemap.xml)을 매번 생성한다. 메인·안내서의 canonical URL만 포함하고 404·앱 소스·Google 확인 파일·중복 게시 경로는 제외한다. 변경 없는 빌드 시간을 `lastmod`로 넣지 않는다.
- 메인·안내서는 각각의 canonical을 가진다. 공개 페이지의 `noindex` 메타나 HTML 리다이렉트가 발견되면 빌드가 실패한다.
- 존재하지 않는 주소는 홈으로 자동 이동시키지 않고 HTTP 404와 자체 오류 화면을 제공한다. 오류 화면은 중첩 경로에서도 동작하는 절대 복구 링크를 사용한다.

Google이 적용하는 robots 파일은 **`https://seo-gali.github.io/robots.txt`**다. [하위 디렉터리의 robots는 호스트 정책이 아니다](https://developers.google.com/crawling/docs/robots-txt/create-robots-txt). 현재 호스트 루트는 404이며 차단 규칙이 없다. 이 저장소가 생성하는 `/dockslate/robots.txt`는 허용 규칙·Sitemap 위치를 담지만 호스트 루트 파일을 대체하지 않는다. 호스트 루트 설정은 별도 사용자 사이트 저장소의 작업 범위다.

Search Console의 `https://seo-gali.github.io/dockslate/` 속성 → **Sitemaps**에서 `https://seo-gali.github.io/dockslate/sitemap.xml`을 제출한다. 공개 URL의 HTTP 200·XML을 확인한 뒤 제출해야 한다. 연결된 브라우저는 로그인되지 않아 제출은 아직 미완료이며, 비밀번호·OAuth 토큰을 저장소에 넣지 않는다. [폐지된 Sitemap ping](https://developers.google.com/search/blog/2023/06/sitemaps-lastmod-ping)은 사용하지 않는다.

엔진 사용료와 라이선스 범위는 FAQ에 표시한다. EXE·ZIP에 `THIRD_PARTY_NOTICES.md`와 구성 요소별 원문·소스의 `licenses` 폴더를 포함한다. 별도 고지·소스 ZIP도 다운로드 폴더에 제공한다. 라이선스 목록과 잠금 파일·공식 바이너리·원문 해시가 다르면 패키징을 중단한다.

## 실행 파일

`site/release.json`의 버전·파일명·크기·SHA-256이 기준이다. 검증한 설치 EXE와 ZIP을 루트 `downloads/`에 포함하고 기존 게시 폴더에도 같은 파일을 복사한다. 두 경로의 동일 파일은 Git에서 같은 blob을 사용한다. 현재 파일은 미서명이며 이전 브라우징 데이터 접근 경고의 원인은 미확인이다.

다운로드 주소:

- [설치 EXE](https://seo-gali.github.io/dockslate/downloads/DockSlate_0.1.0_x64-setup.exe)
- [포터블 ZIP](https://seo-gali.github.io/dockslate/downloads/DockSlate-0.1.0-windows-x64.zip)
- [고지·소스 ZIP](https://seo-gali.github.io/dockslate/downloads/DockSlate-0.1.0-third-party-licenses.zip)

설치 EXE 제작은 `scripts/build-installer.ps1`, 포터블 ZIP 생성은 `npm run package:local`을 사용한다. 상시 자동 제작 workflow는 두지 않는다.

## 화면과 검증

[사이트 데스크톱](assets/site-desktop.png) · [사이트 모바일](assets/site-mobile.png) · [안내서](assets/guide-desktop.png) · [구성도](assets/architecture.svg)

README의 [프로그램 캡처](assets/dockslate-disk.png)는 [B66E9FE7 실제 Windows 앱 검증](results/table-layout.md) 당시 화면이다. 웹페이지 작업 때문에 EXE·엔진을 다시 실행하지 않는다.

검증 기록: [사이트](results/pages-e2e.json) · [로컬 안내서](results/guide-delivery-e2e.json) · [실제 공개 URL](results/public-pages-e2e.json). 공개 URL 확인과 로컬 브라우저 검증은 구분해 기록한다.

최종 로컬 확인: `npm run build`, `npm run build:site`, `npm run build:site -- --publish` 종료 0. 사이트의 실제 Chrome 검사 28개 통과. 루트·기존 게시 폴더의 EXE·ZIP·고지 소스 ZIP의 실제 HTTP 응답과 크기·SHA-256 일치, 완성 HTML·canonical·Sitemap XML·robots·중첩 경로의 실제 404·직접 사용 안내·Google 원문·분리한 React 앱 렌더링을 확인했다. `noindex`·자동 이동을 주입한 빌드는 각각 예상대로 종료 1이며 원문을 복원했다. [SEO 검사](results/pages-seo.json) · [모바일 404](assets/site-404-mobile.png).

공개 사이트 검증은 별도 기록의 대상 커밋·파일 SHA-256을 기준으로 구분한다. 설치 EXE·포터블·고지 ZIP에는 원문 362개·소스 11개·vendor 목록 2개를 직접 대조했다. [배포물 고지 검증](results/license-delivery.json)은 EXE·엔진 실행이나 설치 검증과 구분한다.

이전 고지 배포의 공개 Chrome 검사 10개도 통과했다. EXE·포터블·고지 ZIP을 실제로 내려받아 크기·SHA-256을 확인했으며 안내서·Google 원문·PC·모바일 화면을 확인했다. 원격 제작에 사용한 임시 workflow는 제거했다. 이번 SEO 변경의 공개 확인은 별도 SEO 기록에서 구분한다.

SEO 소스 `e1f8c4d` 반영 후 실제 공개 HTTP 검사 9개도 통과했다. 메인·안내서의 생성 HTML 일치, Sitemap·robots 원문, 중첩 URL의 HTTP 404, 내부 페이지·자산·다운로드의 직접 응답, Google 확인 원문, 호스트 루트 robots 404와 단일 trailing-slash 이동을 확인했다. Search Console는 연결 브라우저의 로그인 부재로 제출 미완료다.

[GitHub Pages 게시 방식](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
