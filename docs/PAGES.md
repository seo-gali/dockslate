# GitHub Pages

공개 주소: [seo-gali.github.io/dockslate](https://seo-gali.github.io/dockslate/)

## 원본과 게시 설정

웹사이트 원본은 `site/`에 두며, 빌드 결과는 Git에서 제외하는 `site-dist/` 한 곳에 생성합니다. 저장소 루트에는 웹사이트 파일을 생성하지 않습니다.

게시 방식은 **Settings → Pages → Build and deployment → Source: GitHub Actions**입니다. [Pages workflow](../.github/workflows/pages.yml)는 `main`의 `site/`·사이트 빌드 스크립트·공개 영수증·다운로드·고지 관련 경로가 바뀌면 실행하며 수동 실행도 지원합니다. README나 일반 개발 문서만 수정한 푸시는 이 workflow의 실행 조건이 아닙니다. Actions 모드 전환은 저장소 설정 변경이므로 별도 승인을 받아 적용합니다. 현재 공개판 0.1.17의 배포·파일 대조는 [공개 기록](results/public-distribution-0.1.17.json)에 있습니다. 로컬 문서 수정만으로 원격 게시가 갱신되지는 않습니다.

사이트의 공개 버전은 `site/release.json`이 정합니다. 앱 개발 버전과 달라도 공개 영수증 `docs/results/public-distribution-<version>.json`의 게시 상태·파일·해시·백신 검사 결과가 맞으면 빌드할 수 있습니다. 미게시 버전·메타데이터 불일치·승인 없는 미완료 검사를 거부하며 사이트 변경만으로 앱을 새로 공개하지 않습니다. 기본적으로 설치 EXE는 완료된 탐지 0건 결과가 필요합니다. 내부 앱·포터블 ZIP의 탐지는 정확한 파일 해시·업체·개수별 사용자 승인과 prerelease를 기록한 경우만 허용하고, 각 파일의 결과를 홈페이지에 표시합니다. 0.1.12의 앱 승인 기록을 보존하며 0.1.14는 앱과 ZIP의 DeepInstinct 탐지 각 1건, 0.1.15는 ZIP의 DeepInstinct 1건을 해시별로 승인받았습니다. 다른 해시·업체·개수나 설치 EXE에는 이 탐지 승인이 적용되지 않습니다.

0.1.16은 2026-11-28 사용자의 “일단 공개해” 지시에 따라 별도 예외를 기록합니다. 차단 상태인 새 파일 4개의 이름·크기·SHA-256 전체와 `unverifiedPublicationApproval`이 일치하고 prerelease인 경우에만 검사 미완료 공개를 허용합니다. 탐지·분석 수는 `null`, 완료는 `false`로 유지합니다. 홈페이지에 **백신 검사 미완료**를 표시하고 없는 VirusTotal 결과 대신 검사 진행 기록으로 연결합니다. 이 예외는 다른 버전·변경된 파일·확인된 탐지 결과·정식 배포에 적용되지 않습니다.

0.1.17은 후속 수정에 대한 사용자의 “공개해” 지시에 따라 같은 형식의 별도 승인을 기록합니다. 새 EXE·ZIP·내부 앱·CLI의 이름·크기·해시를 새 승인과 대조하며 0.1.16의 승인 해시를 재사용하지 않습니다. 미서명·검사 미완료를 고지한 prerelease에 한정하고, 이후 버전이나 확인된 탐지에 자동으로 적용하지 않습니다.

| 원본 | 출력·역할 |
| --- | --- |
| `site/index.html` · `site/styles.css` · `site/main.js` | 공개 메인·자산 |
| `site/guide.html` | 독립 사용 안내서. 사이트·앱·배포 패키지에 복사 |
| `site/404.html` | 중첩 경로에서도 동작하는 오류 화면 |
| `site/google474f5421d7424578.html` | 원문을 유지하는 Google 소유권 확인 파일 |
| `site/release.json` · 버전별 공개 영수증 | 다운로드 3개와 공개판 고지의 버전·크기·SHA-256·고정 소스 커밋 |
| 공개판 고정 커밋의 `licenses/THIRD_PARTY_NOTICES.md` | 공개판과 같은 고지. 개발판 고지로 대체하지 않음 |
| `docs/downloads/` | 과거 패키지가 참조하는 고지 ZIP 원본·0.1.5 고지 스냅샷 |
| `scripts/build-site.mjs` | 메인·404·Sitemap·robots와 다운로드 출력 생성 |
| `src/index.html` → `dist/index.html` | 공개 사이트와 분리된 데스크톱 React 앱 |

로컬 `media/`는 Git 제외 대상입니다. README에는 YouTube 영상·썸네일 주소만 사용하며 영상·원고를 배포 파일로 복사하지 않습니다.

## 빌드와 미리보기

```powershell
npm run build:site
```

릴리스 명세의 EXE·포터블·고지 소스 ZIP을 크기·SHA-256으로 검증하고 공개판 고정 커밋의 `SHA256SUMS.txt`와 대조한 뒤 `site-dist/`를 만듭니다. 로컬 파일이 없으면 고정 Git 객체를 읽고, 그 객체도 없으면 해당 공개 GitHub Release에서 다운로드해 검증합니다. 이미 있는 로컬 파일이 다르면 실패하며 다른 사본으로 숨기지 않습니다. 지문표가 다르면 기존 출력 교체 전에 실패합니다. `site-dist/index.html`을 브라우저로 열어 확인합니다. 로컬 빌드는 게시·파일 업로드를 하지 않습니다. Git 객체가 없는 환경에서는 공개 파일 다운로드가 필요하며 검증용 임시 파일은 작업 후 삭제합니다.

체크섬의 고정 Git 경로는 공개 영수증의 `github.checksumSourcePath`로 기록할 수 있으며 기본값은 `downloads/SHA256SUMS.txt`입니다. 0.1.16은 홈페이지 전환 전 기존 0.1.15 체크섬을 유지하기 위해 릴리스 커밋의 `.github/release016-SHA256SUMS.txt`를 사용했습니다. 어느 경로든 실제 공개 파일의 크기·SHA-256과 일치해야 하며 불일치하면 차단합니다.

사이트 빌드는 현재 0.1.3~0.1.15 고지 ZIP 13개를 `docs/downloads/` 원본에서 출력의 `downloads/`와 `docs/downloads/` 양쪽으로 복사합니다. 이전 패키지의 공개 URL 26개를 유지하면서 저장소에서는 중복 ZIP을 관리하지 않습니다. 배포 파일이나 라이선스 원문을 다시 압축하지 않습니다.

현재 다운로드 버튼은 [GitHub Release](https://github.com/seo-gali/dockslate/releases/tag/v0.1.17)의 첨부 파일로 연결합니다. Release에는 설치 EXE·포터블 ZIP·고지 ZIP·`SHA256SUMS.txt`를 함께 올립니다. 0.1.17은 백신 검사 미완료를 다운로드 전에 표시하고 [진행·승인 기록](results/virustotal-0.1.17.json)을 연결합니다. 검사 결과가 없는 파일을 탐지 0건으로 표시하지 않습니다. 사이트의 기존 `downloads/` 파일 주소와 체크섬 파일도 유지합니다.

설치 EXE는 `scripts/build-installer.ps1`, 포터블은 `npm run package:local`로 별도 생성합니다. Pages workflow는 앱 설치 파일을 빌드하지 않습니다. `site-dist/`에는 공개 웹 파일과 다운로드만 포함하며 앱 소스·검증 자료·로컬 영상은 게시하지 않습니다.

실행 파일은 미서명 개발 버전입니다. 새 파일의 검사 결과와 과거 경고 조사는 각 버전·해시의 기록으로 구분합니다. [서명 상태](results/code-signing.md) · [패키지 고지 검증](results/license-delivery.json)

## 검색 색인

[GitHub Pages 정적 호스팅](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)에 맞춰 완성 HTML을 빌드합니다. JavaScript 없이도 다운로드·기능·사용법이 제공되며 별도 SSR 서버는 없습니다.

- [Sitemap](https://seo-gali.github.io/dockslate/sitemap.xml)은 공개 메인·안내서의 canonical만 포함합니다. 404·앱 소스·Google 확인 파일·중복 경로를 제외하며 빌드 시각을 임의의 `lastmod`로 넣지 않습니다.
- 공개 페이지의 `noindex` 메타나 HTML 자동 이동은 빌드에서 차단합니다. 없는 주소에는 HTTP 404와 복구 링크를 제공합니다.
- Google이 적용하는 robots는 **`https://seo-gali.github.io/robots.txt`**입니다. [하위 디렉터리의 robots는 호스트 정책이 아닙니다](https://developers.google.com/crawling/docs/robots-txt/create-robots-txt). 생성하는 `/dockslate/robots.txt`는 호스트 루트 파일을 대체하지 않습니다.
- **Search Console 제출은 사용자가 직접 진행합니다.** `https://seo-gali.github.io/dockslate/` 속성에서 Sitemap URL을 제출합니다. 실제 제출·색인 여부는 확인하지 않았습니다. 계정 비밀값을 저장소에 넣거나 폐지된 Sitemap ping을 사용하지 않습니다.

## 검증 기록

[로컬 사이트 검사](results/pages-e2e.json)는 파일·HTTP 렌더링, 안내서, 키보드·모바일, SEO와 다운로드를 확인합니다. [안내서 검사](results/guide-delivery-e2e.json)는 사이트 원본·사이트 출력·앱 출력의 독립 HTML을 확인합니다. 두 기록의 실행 날짜와 공개 배포 검사 여부를 구분하세요.

[0.1.16 공개 파일·사이트 검사](results/public-distribution-0.1.16.json)는 공개 파일 4개·다운로드 링크·백신 검사 미완료 고지·정적 자산·옛 고지 주소 26개를 확인했습니다. [0.1.14 검사](results/public-distribution-0.1.14.json)·[0.1.13 검사](results/public-distribution-0.1.13.json)·[0.1.6 공개 다운로드](results/public-release-0.1.6.json)·[공개 SEO](results/pages-seo.json)는 당시의 원격 상태입니다. 로컬 구조를 변경했다고 원격 재배포나 앱 재검증이 완료된 것은 아닙니다.

[사이트 화면](assets/site-desktop.png) · [모바일](assets/site-mobile.png) · [404](assets/site-404-mobile.png) · [안내서](assets/guide-desktop.png)
