# 0.1.3 표·선택 목록 수정

2026-10-29. 로컬 빌드·화면 검증 완료, 설치 파일과 공개 다운로드 교체는 준비 중이다. 이전 버전의 전체 검사를 재실행했다는 뜻은 아니다.

- 컨테이너 표의 컨테이너·이미지 ID 반복 표시를 제거했다. 상세의 컨테이너 ID와 로컬 이미지 표의 이미지 ID는 유지한다.
- 창 너비가 바뀔 때 공통 표 너비를 다시 계산한다. 열 최소 너비·수동 조절·저장을 유지한다.
- 긴 목록은 표 안에서 스크롤하고 머리글을 고정한다. 페이지 이동은 표 밖에 둔다. 빌더 선택 배지는 이름 옆에 표시한다.
- 선택 박스는 내용에 맞는 너비와 테마를 사용하며 펼친 목록에도 같은 스타일을 적용한다.
- 빌드 진행 탭의 중복 요약, 디스크 사용량 카드의 반복 설명·중복 안내를 줄였다. 공유 레이어·VHDX·볼륨 보존 안내는 유지한다.
- 사용자가 직접 선택할 [Dockerfile·Compose 예제](../../examples/basic-web/README.md)를 추가했다. ZIP·설치 파일에 포함하는 설정도 추가했다. 이번 검증에서는 컨테이너를 만들거나 실행하지 않았다.

## 실제 검증

| 검사 | 결과 |
| --- | --- |
| `powershell -NoProfile -File scripts/desktop.ps1 -Mode build` | 종료 0. TypeScript·Vite·Windows release 빌드 |
| `powershell -NoProfile -File scripts/build-cli.ps1` | 종료 0 |
| `cargo check --manifest-path src-tauri/Cargo.toml --locked --offline` | 종료 0 |
| `node scripts/verify-table-layout.mjs` | 종료 0, 실제 Windows 앱의 [22개 검사](table-layout.json) 통과 |
| CLI `--version`, `--debug --version`, `compose version --short`, `buildx version` | 모두 종료 0. Docker 29.8.2·Compose 5.6.0·Buildx 0.38.0 |
| 예제 `docker-compose.exe -f examples/basic-web/compose.yaml config --quiet` | 종료 0. 빌드·실행은 사용자가 진행 |
| `node scripts/verify-license-inventory.mjs` | 종료 0. 구성 요소 555·고지 362·소스 11, 누락 0 |
| 의존성 대조 | 의존성 선언·lock 그래프 동일. 앱 버전 메타데이터만 변경 |
| `powershell -NoProfile -File scripts/build-installer.ps1 -SkipBuild` | 종료 1. NSIS가 `installer/user-path.ps1`을 열지 못해 중단. 설치 파일 실행 없음 |

화면 검사는 1000×640·1668×900의 표 6종, 창 확대, 수동 열 조절, 고정 머리글, ID 표시 범위, 실제 선택 목록 디자인, 빌더 배지를 포함한다. 한국어 1000×640 디스크 화면은 본문 높이·스크롤 높이가 모두 582px, 표 높이가 158px인 것도 확인했다. 검증 전후 기존 컨테이너 ID·상태가 같았고 렌더러 예외는 없었다.

앱 SHA-256: `28D11804D3CEB6292A95AB6506096F401AA77316C30A45AF4E8ED5845EDA89C4`

CLI SHA-256: `D8E2AD91190B180E4EEEDD37C103A78BCE34EA89731243A6FC33C5C7C83B0594`

설치·제거 실행, 전체 회귀, DB 동작, 서명과 기존 보안 경고 해소는 검사하지 않았다. 실제 설치 파일 내부 검사·공개 다운로드 결과는 완료 후 별도로 기록한다.
