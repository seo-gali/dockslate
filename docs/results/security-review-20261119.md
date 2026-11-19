# 보안 점검과 수정

2026-11-19. 개발판 0.1.10의 현재 소스와 동봉 Windows 도구를 점검했다. **공개 배포 승인이나 전체 취약점 해결 판정은 아니다.** 공개판은 0.1.9이며, 앞서 만든 [구조 개편 EXE·ZIP](refactor-packages-20261116.md)은 이번 보안 수정 전 파일이다.

## 수정한 내용

- 앱의 개발자 도구를 끄고 리소스 응답에 `nosniff`·카메라/마이크/위치 권한 제한을 추가했다. 앱·사이트의 referrer 전달을 막고 공개 HTML의 폼 전송을 CSP로 차단했다. 개발 서버는 기존 loopback 바인딩에 CORS 거부를 추가했다.
- Rust 네트워크 이름 검사에서 끝의 제어문자가 `trim()`으로 사라져 받아들여지는 입력을 거부했다. 임의 명령 실행 취약점으로 확대 해석하지 않는다.
- Tokio 1.53.2 → 1.53.3으로 [AsyncFd 권고](https://rustsec.org/advisories/RUSTSEC-2026-0386.html)를 반영했다. 전체 잠금 파일을 무차별 갱신하지 않았다.
- 공식 Windows CLI 29.10.0·Compose 5.8.0·Buildx 0.39.0으로 갱신했다. 세 파일의 내장 Go는 1.27.4이며 해당 표준 라이브러리 버전의 OSV 결과는 0건이다. 기존 1.26.8과 구분한다. Linux 엔진 설치 핀과 이 PC의 엔진은 변경하지 않았다.
- CLI 프로필의 Compose 5.6.0·Buildx 0.38.0 파일은 이전 공식 SHA-256과 정확히 일치할 때만 교체한다. 일치하지 않는 파일은 보존하고 실행을 차단한다. CNG로 해시를 계산하며 전역 Docker 설정·인증 파일을 읽어 옮기지 않는다. 상속된 API 버전·사용자 정의 HTTP 헤더도 제거한다.
- 잘못된 로컬 Docker 요청의 시각·이벤트명·HTTP 오류 코드만 `%LOCALAPPDATA%\DockSlate\security.jsonl`에 기록한다. 명령·헤더·본문·파일명·토큰을 기록하지 않는다. 최대 64KiB이며 가득 차면 새 기록부터 다시 보관한다. 자동 신고·외부 수집·실시간 경보 서비스는 추가하지 않았다.
- `.env*`와 개인 키 파일을 Git 제외 목록에 추가했다. 값이 출력되지 않는 작업 트리·Git 이력 검사와 CI 검사를 추가했다. 패턴 검사는 모든 종류의 비밀 탐지를 보장하지 않는다.
- 소스 CI의 npm 검사는 빌드 의존성도 포함한다. 매주 월요일 03:17 UTC 및 수동 실행의 Cargo·Go 권고 검사 정의를 추가했다. 권고가 남으면 종료 코드 1이며 조용히 무시하지 않는다. 이 CI 변경은 아직 푸시·원격 실행하지 않았다.

## 요청 항목별 적용 범위

DockSlate는 로컬 Windows 앱과 정적 사이트다. 계정·회원 DB·로그인 세션·결제 서버가 없다. 사용자 컨테이너의 서비스는 별도 운영 대상이다.

| 요청 | 실제 적용·확인 | 상태와 한계 |
| --- | --- | --- |
| 적절한 인증 | 로컬 pipe는 현재 Windows 사용자 SID로 제한하고 원격 연결을 거부한다. CLI는 pipe 서버의 SID·실행 파일 경로를 확인한다 | 기존 보호 확인. 같은 사용자 권한의 악성 코드까지 격리하는 경계는 아님 |
| 모든 비밀번호 해싱 | 앱 계정·비밀번호 저장소 없음 | 해당 없음. 사용자 DB 비밀번호·Docker 로그인 자료를 임의로 변경하지 않음 |
| 관리자 경로 잠금 | 웹 관리자 경로 없음. 권한 상승은 명시적 승인과 Windows UAC 사용 | 승인 없는 상승 거부 검사 통과 |
| 세션 쿠키 보안 | 앱 로그인 쿠키·서버 세션 없음 | 해당 없음 |
| 비밀번호 재설정 링크 만료 | 재설정 기능 없음 | 해당 없음. 별도로 위험 작업 승인 토큰의 120초 만료·소비 후 재사용 거부를 검사 |
| 키·시크릿 코드 밖으로 이동 | 현재 소스와 Git 변경 이력의 시크릿 패턴 검사, `.env*`·개인 키 제외 | 발견 0건. 새 키 저장소나 인증 서비스는 추가하지 않음 |
| 환경 변수 검토 | 아래 참조 목록·제거 규칙 확인 | 변수 값 전체·비밀 파일·자격 증명 관리자는 열람하지 않음 |
| Git 이력 유출 검사 | 모든 로컬 refs와 삭제된 임시 빌드 커밋까지 추가된 텍스트 검사 | 추가 줄 101,324개, 발견 0건. 바이너리·서드파티 원문·로컬 에이전트 디렉터리는 제외 |
| 노출 키 폐기·교체 | 확인된 실제 키 없음 | 교체 대상 없음. 탐지되지 않은 키가 없다는 보증은 아님 |
| DB 보안·매개변수화 쿼리 | 앱 소유 SQL DB·쿼리 없음 | 해당 없음. 사용자 SQL 컨테이너·DB·권한·데이터를 변경하지 않음 |
| 서버에서 폼 검증 | Tauri Rust 명령에서 경로·이름·승인·엔진 소유권 검증 | 잘못된 입력을 엔진 접근 전에 거부하는 검사 통과 |
| 업로드 형식·크기 제한 | 인터넷 업로드 API 없음. 로컬 Compose·tar·빌드 기록 선택 경계 검사 유지 | Compose 1MiB·tar 2GiB·빌드 기록 64MiB 한도. 원격/ADS/잘못된 확장자·경로 이탈 거부 검사 통과 |
| 가격·결제 서버 검증 | 가격 계산·주문·결제 기능 없음 | 해당 없음 |
| HTTPS 강제 | 사이트 HTTPS 응답·HSTS 확인. 구성 요소 다운로드는 HTTPS와 해시 고정 | GitHub Pages의 HTTP→HTTPS 동작도 별도 확인. 로컬 pipe에 TLS를 억지로 추가하지 않음 |
| XSS·CSRF | React 텍스트 이스케이프·스크립트 CSP 유지. 원격 페이지의 Tauri API 권한 없음. 공개 사이트 폼 전송 차단 | 계정 쿠키 기반 CSRF API 없음. 네이티브 WebView의 모든 공격 경로를 재현한 침투 테스트는 아님 |
| CORS 제한 | Vite 개발 서버 `cors: false`, `127.0.0.1` 바인딩 | 공개 정적 Pages의 `Access-Control-Allow-Origin: *`는 인증 API 설정과 구분 |
| 보안 헤더 | Tauri가 지원하는 두 헤더 추가, HTML CSP·referrer 정책 적용 | Pages에 임의 HTTP 응답 헤더를 설정할 수 있는 것처럼 가짜 설정 파일을 만들지 않음 |
| 속도 제한 | 공개 앱 API 없음. pipe 32개 인스턴스 중 작업 최대 31개, 헤더 64KiB·컨테이너 생성 JSON 16MiB·시간 제한, 변경 작업 잠금 | 기존 자원 한도 확인. 다른 Docker 스트림 전체의 16MiB 제한이나 초당 요청 수 제한·DDoS 부하 시험으로 간주하지 않음 |
| 프로덕션 디버그 끄기 | `devtools: false`, 최적화 release 빌드 | 일반 사용자 실행의 `WEBVIEW2_*` 진단 환경 재정의까지 전부 제거한 것은 아님. 관리자 재실행에서는 제거 |
| 취약 의존성 갱신 | Tokio와 공식 Windows 도구 갱신, 아래 남은 권고 분류 | 전체 해결 아님. 공식 도구 바이너리를 임의 수정하거나 출처가 다른 재빌드로 바꾸지 않음 |
| 미사용 패키지 제거 | 직접 의존성은 기존 실제 사용 확인 결과 유지 | 새 패키지 0개. 플랫폼별 전이 의존성을 잠금 파일에서 수동 삭제하지 않음 |
| 노출 파일 확인 | 정적 사이트 출력·앱 dist·포터블 ZIP을 검사 | 비밀 파일·소스맵·저장소 내부 디렉터리 노출 검사. 과거 보안 원본·법적 고지는 보존 |
| 의심 활동 로그·모니터링 | 위의 제한된 로컬 거부 로그·주간 의존성 검사 정의 | pipe ACL에서 연결 자체가 거절된 시도, 모든 OS 활동·앱 승인 거부를 수집하는 시스템은 아님. 원격 CI는 미실행 |
| 모든 보호 기능 테스트 | Node·Rust·Windows·오프라인 CLI·정적 사이트 검사 | 수행 결과와 미검증을 아래에서 구분. 설치·실제 엔진·사용자 DB 변경 시험은 수행하지 않음 |

[Tauri의 권한 경계](https://v2.tauri.app/security/capabilities/)는 번들 코드와 원격 출처를 구분한다. [추가 헤더 설정](https://v2.tauri.app/security/http-headers/)은 리소스 프로토콜 응답에 적용되며 IPC·오류 응답 전체에 적용되는 것으로 간주하지 않는다.

## 환경 변수와 비밀 범위

| 참조 | 용도·처리 |
| --- | --- |
| `LOCALAPPDATA` | CLI 프로필·빌드 기록·거부 로그의 현재 사용자 경로. 절대 경로·일반 파일/폴더·reparse 경계 확인 |
| `DOCKER_HOST` | 소유 pipe/Unix 소켓으로 설정 |
| `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `DOCKER_TLS*`, `DOCKER_CERT_PATH`, `DOCKER_API_VERSION`, `DOCKER_CUSTOM_HEADERS`, `BUILDX_*` | 관리 연결·도구 실행 경로에서 외부 연결 설정 상속을 제거. CLI에서 사용자가 직접 주는 인수는 별도 사용자 명령 |
| `COMPOSE_*` | GUI의 제한 가져오기와 일반 사용자가 실행하는 CLI를 구분. GUI에서 `.env`·비밀 파일 자동 읽기 차단 유지 |
| `WEBVIEW2_*` | 관리자 재실행에서 제거, 전용 관리자 프로필 사용. 일반 사용자 진단 환경은 위 한계 참조 |
| `CARGO_HOME`, `RUSTUP_HOME`, `CARGO_NET_OFFLINE`, `PATH`, proxy 변수 | 로컬 빌드 도구 선택·오프라인 빌드 범위. 전역 환경 설정은 변경하지 않음 |

## 남은 의존성 권고

최종 npm audit는 빌드 도구 포함 **0건, 종료 0**이다. 앞선 High 4개는 하나의 picomatch 권고가 전파된 결과였으며, [GHSA-fc5q-39xc-vjpf가 11월 18일 철회](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)된 뒤 재검사에서 사라졌다. 이를 우리 코드 수정으로 해결했다고 기록하지 않는다. Vite 강제 다운그레이드·`audit fix --force`는 하지 않았다.

전체 Cargo 잠금 파일과 Windows Go 목록의 OSV 조회는 **716개 버전, 일치 12개 버전·권고 ID 22개, 종료 1**이다. alias가 포함되어 독립 취약점 22개를 의미하지 않는다. 실행 대상·문제 함수의 실제 사용 여부를 정밀 분석한 `govulncheck` 결과도 아니다.

| 목록에서 확인한 권고 | 분류·후속 조치 |
| --- | --- |
| chrono `RUSTSEC-2026-0543`, proc-macro-error `RUSTSEC-2024-0370` | 유지보수 중단 안내. 취약 코드 실행 증명과 구분. 현재 Windows `cargo tree -i`에서 연결 경로가 나오지 않음 |
| glib `RUSTSEC-2024-0429` / `GHSA-wrw7-89jp-8q8g` | Linux GTK 계열. Windows `cargo tree`에 없음. Tauri의 서로 다른 GTK 버전을 수동 치환하지 않음 |
| Compose: compress 1.20.0 `GO-2026-6865`; OTel 1.46.0 `GHSA-q7gw-24fr-5p69`; x/net 0.60.0 `GO-2026-6860`, `GO-2026-6866` | 공식 최신 Compose에도 남는 버전 일치. 압축·추적 속성·HTML 파서 경로의 실제 영향 및 upstream 수정 확인 필요 |
| Compose·Buildx: x/crypto 0.57.0·0.58.0 `GO-2026-5932` | 대상은 OpenPGP 패키지. 모듈 전체 사용을 해당 패키지 호출로 간주하지 않음 |
| Buildx: docker/docker 28.5.2의 Moby 권고 9개 ID | 서버/daemon 권고와 Windows 클라이언트의 내장 모듈을 구분. 예를 들어 [archive 실행 권고의 Docker Engine 수정판은 29.5.1](https://github.com/moby/moby/security/advisories/GHSA-x86f-5xw2-fm2r). 설치 핀 29.8.2를 단지 Go 모듈명 때문에 28.5.2 엔진으로 판정하지 않음 |
| Buildx: go-archive 0.2.0 `GO-2026-6253` / `GHSA-hfg8-hc9c-6c3h` | [아카이브 추출 권고](https://github.com/moby/go-archive/security/advisories/GHSA-hfg8-hc9c-6c3h). 수정 0.3.0 이상. 실제 Windows Buildx 경로의 도달성 또는 공식 수정판 확인 전 해결로 간주하지 않음 |
| CLI·Buildx vendor 목록: distribution 2.8.3 `GO-2026-6778` / `GHSA-685w-q87j-wqw3` | manifest digest 검증 관련. 전체 vendor 선언을 보수적으로 검사한 일치이며 실제 함수 포함·호출은 추가 확인 필요 |

원시 탐지 목록과 대상은 [기계 판독 기록](security-review-20261119.json)에 있다. 위 권고는 포괄적인 “안전” 판정으로 덮지 않는다. 기존 Linux 엔진·containerd·WSL 커널·WebView2·사용자 컨테이너의 패치 상태 전체는 이번 검사 범위가 아니다.

## 검증과 배포 경계

- `npm run check`: SHA 고정·IPC 85개 계약/88개 native 명령·시크릿·문서·TypeScript·Node 테스트 **14개 통과**.
- `powershell -NoProfile -File scripts/check-windows.ps1 -Offline`: Rust check·보안 테스트 **10개**(앱 9·CLI 해시 1), Windows 프로세스 검사 **7개 통과**. 승인 거부·토큰 만료/재사용·경로·입력·HTTP 프레이밍·로그 크기를 포함한다.
- 공식 CLI `--version`, `--debug --version`, Compose/Buildx 버전, 기존 공식 플러그인 갱신, 알 수 없는 플러그인 보존 **6개 통과**. 분리된 임시 프로필만 사용했다.
- `node scripts/verify-license-inventory.mjs`: **588개 구성 요소·원문 392개·소스 11개** 검증. 새 Go 모듈 104개의 전체 내용 h1은 Go 체크섬 DB와 일치했다. 라이선스 검사는 취약점 검사를 대신하지 않는다.
- 최적화 앱·CLI 빌드와 `npm run build:site` 통과. 사이트 출력은 공개판 0.1.9를 유지하며 게시하지 않았다.
- 로컬 사이트 3개 페이지의 실제 브라우저에서 스크립트 삽입·폼 전송 차단, referrer 정책·정상 화면을 확인했다. 공개 사이트는 HTTP 301→HTTPS 200·HSTS를 확인했으며 새 HTML을 배포한 결과로 기록하지 않는다.
- 첫 native 테스트가 제어문자 허용을 찾아 실패한 뒤 입력 검사 수정 후 통과했다. Tauri가 지원하지 않는 헤더명과 CLI 업데이트 코드의 컴파일 오류도 수정 후 재검증했다. npm 감사 출력의 UTF-16 판독 실패는 출력을 정규화해 원래 감사 종료 0과 별도로 확인했다.

새 설치 EXE 실행·업그레이드·WSL 시작/종료·컨테이너/이미지/볼륨 생성/삭제·사용자 DB 변경·서명·새 VirusTotal 업로드는 하지 않았다. 앞서 승인받은 GitHub 설치판 포장 1회는 끝났고 임시 브랜치도 삭제했다. 추가 원격 빌드·푸시·공개 배포는 수행하지 않았다.
