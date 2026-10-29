# GitHub Pages

공개 주소: [seo-gali.github.io/dockslate](https://seo-gali.github.io/dockslate/)

## 게시 설정

**Settings → Pages → Source: Deploy from a branch → Branch: main → Folder: /(root) → Save**

`main`에서 작업한다. 루트와 기존 `/docs` 게시본을 함께 생성하며 Markdown·이미지는 보존한다.

| 원본 | 출력·역할 |
| --- | --- |
| `site/index.html` · `site/styles.css` · `site/main.js` | 공개 메인·자산 |
| `site/404.html` | 중첩 경로에서도 동작하는 오류 화면 |
| 루트 `guide.html` | 독립 사용 안내서. 사이트·앱 빌드에 복사 |
| `google474f5421d7424578.html` | 원문을 유지하는 Google 소유권 확인 파일 |
| `site/release.json` | 다운로드 3개의 버전·크기·SHA-256 |
| `scripts/build-site.mjs` | 메인·404·Sitemap·robots와 다운로드 출력 생성 |
| `src/index.html` → `dist/index.html` | 공개 사이트와 분리된 데스크톱 React 앱 |

## 업데이트

```powershell
npm run build:site
npm run build:site -- --publish
```

첫 명령은 릴리스 명세의 EXE·포터블·고지 소스 ZIP을 검증해 `site-dist`를 만든다. 두 번째는 같은 검증 후 루트와 `/docs` 게시본을 갱신한다. 변경은 위 표의 원본에 반영한 뒤 다시 빌드한다. 빌드 자체는 외부로 전송하지 않으며, 커밋·푸시는 승인 범위에서 수행한다.

설치 EXE는 `scripts/build-installer.ps1`, 포터블은 `npm run package:local`로 생성한다. 상시 자동 제작 workflow는 두지 않는다. 실행 파일은 미서명 개발 버전이며 보안 경고의 원인은 미확인이다. [다운로드](https://seo-gali.github.io/dockslate/#download) · [서명 상태](results/code-signing.md) · [패키지 고지 검증](results/license-delivery.json)

## 검색 색인

[GitHub Pages의 정적 호스팅 방식](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)에 맞춰 완성 HTML을 빌드한다. JavaScript 없이도 다운로드·기능·사용법이 제공되며, 요청 시 실행하는 SSR 서버는 없다.

- [Sitemap](https://seo-gali.github.io/dockslate/sitemap.xml)은 빌드마다 공개 페이지 목록에서 생성한다. 메인·안내서의 canonical만 포함하고 404·앱 소스·Google 확인 파일·중복 경로는 제외한다. 빌드 시각을 임의의 `lastmod`로 넣지 않는다.
- 공개 페이지의 `noindex` 메타나 HTML 자동 이동은 빌드에서 차단한다. 없는 주소는 자동 이동 없이 HTTP 404와 복구 링크를 제공한다.
- Google이 적용하는 robots는 **`https://seo-gali.github.io/robots.txt`**다. [하위 디렉터리의 robots는 호스트 정책이 아니다](https://developers.google.com/crawling/docs/robots-txt/create-robots-txt). 최근 공개 검사에서 호스트 루트는 404로 차단 규칙이 없었다. 생성한 `/dockslate/robots.txt`는 호스트 루트 파일을 대체하지 않는다.
- **Search Console 제출은 사용자가 직접 진행한다.** `https://seo-gali.github.io/dockslate/` 속성 → Sitemaps에 `https://seo-gali.github.io/dockslate/sitemap.xml`을 제출한다. 실제 제출·색인 여부는 아직 확인되지 않았다. 계정 비밀값을 저장소에 넣거나 [폐지된 Sitemap ping](https://developers.google.com/search/blog/2023/06/sitemaps-lastmod-ping)을 사용하지 않는다.

## 검증 근거

| 범위 | 실제 결과·기록 |
| --- | --- |
| 0.1.1 공개 다운로드 | [실제 공개 파일 검증](results/public-release-0.1.1.json). EXE·포터블·고지 ZIP 3개 HTTP 200과 크기·SHA-256 일치. 공개 HTML 일치, 구버전 3개 HTTP 404 |
| 최신 로컬 사이트 | [Chrome 28개](results/pages-e2e.json) 통과. 파일/HTTP·JS 비활성·canonical·Sitemap XML·robots·404·다운로드 해시·앱 분리 확인 |
| 최신 공개 SEO | [HTTP 9개](results/pages-seo.json) 통과. 소스 `e1f8c4d`의 생성 HTML·Sitemap·robots·404·링크·Google 원문 일치 |
| 색인 차단 방지 | `noindex`·HTML 자동 이동을 주입한 빌드는 예상대로 종료 1, 원문 복원. 위 SEO 기록에 포함 |
| 이전 공개 다운로드 배포 | [Chrome 10개](results/public-pages-e2e.json) 통과. EXE·포터블·고지 ZIP 실제 다운로드와 크기·SHA-256 대조. 현재 SEO 검사와 구분 |
| 이전 독립 안내서 | [실제 파일 검사](results/guide-delivery-e2e.json). 검사 당시 산출물 기준 |

`npm run build`, `npm run build:site`, `npm run build:site -- --publish`는 최근 코드 검증에서 종료 0이었다. 문서만 바꾸는 작업에서는 링크·앵커·기록 일관성을 확인한다. 과거 결과를 최신 앱 전체 검사나 정식 배포 승인으로 표시하지 않는다.

[사이트 화면](assets/site-desktop.png) · [모바일](assets/site-mobile.png) · [404](assets/site-404-mobile.png) · [안내서](assets/guide-desktop.png) · [실제 앱 캡처 근거](results/table-layout.md)
