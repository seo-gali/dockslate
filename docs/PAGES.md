# GitHub Pages

공개 주소: [seo-gali.github.io/dockslate](https://seo-gali.github.io/dockslate/)

## 원본과 게시 설정

웹사이트 원본은 `site/`에 두며, 빌드 결과는 Git에서 제외하는 `site-dist/` 한 곳에 생성합니다. 저장소 루트에는 웹사이트 파일을 생성하지 않습니다.

게시 방식은 **Settings → Pages → Build and deployment → Source: GitHub Actions**입니다. [Pages workflow](../.github/workflows/pages.yml)는 승인된 `main` 변경을 반영해 사이트를 빌드·게시하며 수동 실행도 지원합니다. Actions 모드 전환은 저장소 설정 변경이므로 별도 승인을 받아 적용합니다. 현재 작업의 원격 전환·게시 여부는 [요청 현황](REQUEST_STATUS.md)에 기록합니다.

릴리스 준비 중 `package.json`과 `site/release.json`의 버전이 다르면 SHA 고정 검사만 실행하고 사이트 빌드·게시를 건너뛰어 기존 사이트를 유지합니다. 파일·체크섬·공개 Release를 준비하고 게시를 승인받은 뒤 릴리스 명세의 버전을 맞춥니다. 버전이 다른 준비 상태에서는 로컬 `build:site`도 기존 버전 일치 검사로 거부합니다.

| 원본 | 출력·역할 |
| --- | --- |
| `site/index.html` · `site/styles.css` · `site/main.js` | 공개 메인·자산 |
| `site/guide.html` | 독립 사용 안내서. 사이트·앱·배포 패키지에 복사 |
| `site/404.html` | 중첩 경로에서도 동작하는 오류 화면 |
| `site/google474f5421d7424578.html` | 원문을 유지하는 Google 소유권 확인 파일 |
| `site/release.json` · `downloads/` | 현재 다운로드 3개의 버전·크기·SHA-256과 배포 원본 |
| `licenses/THIRD_PARTY_NOTICES.md` | 현재 고지. 사이트의 `downloads/THIRD_PARTY_NOTICES.md`로 복사 |
| `docs/downloads/` | 과거 패키지가 참조하는 고지 ZIP 원본·0.1.5 고지 스냅샷 |
| `scripts/build-site.mjs` | 메인·404·Sitemap·robots와 다운로드 출력 생성 |
| `src/index.html` → `dist/index.html` | 공개 사이트와 분리된 데스크톱 React 앱 |

로컬 `media/`는 Git 제외 대상입니다. README에는 YouTube 영상·썸네일 주소만 사용하며 영상·원고를 배포 파일로 복사하지 않습니다.

## 빌드와 미리보기

```powershell
npm run build:site
```

릴리스 명세의 EXE·포터블·고지 소스 ZIP을 크기·SHA-256으로 검증하고 `downloads/SHA256SUMS.txt`의 세 항목과 대조한 뒤 `site-dist/`를 만듭니다. 지문표가 다르면 기존 출력 교체 전에 실패합니다. `site-dist/index.html`을 브라우저로 열어 확인합니다. 로컬 명령은 외부로 전송하지 않습니다.

사이트 빌드는 0.1.3~0.1.6 고지 ZIP을 `docs/downloads/` 원본에서 출력의 `downloads/`와 `docs/downloads/` 양쪽으로 복사합니다. 이전 패키지의 공개 URL 8개를 유지하면서 저장소에서는 중복 ZIP을 관리하지 않습니다. 배포 파일이나 라이선스 원문을 다시 압축하지 않습니다.

현재 다운로드 버튼은 [GitHub Release](https://github.com/seo-gali/dockslate/releases/tag/v0.1.7)의 첨부 파일로 연결합니다. Release에는 설치 EXE·포터블 ZIP·고지 ZIP·`SHA256SUMS.txt`를 함께 올리고, 설치판과 포터블의 SHA-256에 대응하는 VirusTotal 결과를 연결합니다. 사이트의 기존 `downloads/` 파일 주소와 체크섬 파일도 유지합니다. [검사 결과](results/virustotal-0.1.7.json)는 조회 시점·탐지·시간 초과·미지원 개수를 구분합니다.

설치 EXE는 `scripts/build-installer.ps1`, 포터블은 `npm run package:local`로 별도 생성합니다. Pages workflow는 앱 설치 파일을 빌드하지 않습니다. `site-dist/`에는 공개 웹 파일과 다운로드만 포함하며 앱 소스·검증 자료·로컬 영상은 게시하지 않습니다.

실행 파일은 미서명 개발 버전이며 과거 보안 경고의 원인은 미확인입니다. [서명 상태](results/code-signing.md) · [패키지 고지 검증](results/license-delivery.json)

## 검색 색인

[GitHub Pages 정적 호스팅](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)에 맞춰 완성 HTML을 빌드합니다. JavaScript 없이도 다운로드·기능·사용법이 제공되며 별도 SSR 서버는 없습니다.

- [Sitemap](https://seo-gali.github.io/dockslate/sitemap.xml)은 공개 메인·안내서의 canonical만 포함합니다. 404·앱 소스·Google 확인 파일·중복 경로를 제외하며 빌드 시각을 임의의 `lastmod`로 넣지 않습니다.
- 공개 페이지의 `noindex` 메타나 HTML 자동 이동은 빌드에서 차단합니다. 없는 주소에는 HTTP 404와 복구 링크를 제공합니다.
- Google이 적용하는 robots는 **`https://seo-gali.github.io/robots.txt`**입니다. [하위 디렉터리의 robots는 호스트 정책이 아닙니다](https://developers.google.com/crawling/docs/robots-txt/create-robots-txt). 생성하는 `/dockslate/robots.txt`는 호스트 루트 파일을 대체하지 않습니다.
- **Search Console 제출은 사용자가 직접 진행합니다.** `https://seo-gali.github.io/dockslate/` 속성에서 Sitemap URL을 제출합니다. 실제 제출·색인 여부는 확인하지 않았습니다. 계정 비밀값을 저장소에 넣거나 폐지된 Sitemap ping을 사용하지 않습니다.

## 검증 기록

[로컬 사이트 검사](results/pages-e2e.json)는 파일·HTTP 렌더링, 안내서, 키보드·모바일, SEO와 다운로드를 확인합니다. [안내서 검사](results/guide-delivery-e2e.json)는 사이트 원본·사이트 출력·앱 출력의 독립 HTML을 확인합니다. 두 기록의 실행 날짜와 공개 배포 검사 여부를 구분하세요.

[0.1.6 공개 다운로드](results/public-release-0.1.6.json)와 [공개 SEO](results/pages-seo.json)는 검사 당시의 원격 상태입니다. 로컬 구조를 변경했다고 원격 재배포나 앱 재검증이 완료된 것은 아닙니다.

[사이트 화면](assets/site-desktop.png) · [모바일](assets/site-mobile.png) · [404](assets/site-404-mobile.png) · [안내서](assets/guide-desktop.png)
