# DockSlate 독립 엔진 구현·실행 검증

## 2026-10-17 컨테이너 실행·고급 설정·네트워크·검색 접기 (최신)

최신 Windows EXE는 3,801,600 B, SHA-256 `974A6202AA05F445E63E55603CB5EAE3D4EF70D2E00412E60EC16FB248481DCE`다. `.\scripts\desktop.ps1 -Mode build`는 exit 0, MSVC release 1분 54초로 완료됐다. 프런트엔드 빌드, 오프라인 Cargo check와 Rust format 검사도 통과했다. 의존성·lock 파일 변경과 새 REA MCP 호출은 없다. 이번 기능은 DockSlate 독자 설계이며 [Docker 실행 옵션](https://docs.docker.com/engine/containers/run/), [bridge 네트워크](https://docs.docker.com/engine/network/drivers/bridge/)와 공식 Moby API 명세를 참고했다.

로컬 이미지 행에 실행 버튼을 추가했다. 생성·시작 후 전체 공유 데이터를 갱신하고 Containers의 해당 컨테이너 로그를 연다. 더보기에는 환경 변수, CMD·ENTRYPOINT, 작업 디렉터리, 재시작 정책, 메모리·CPU 제한과 네트워크 선택·bridge 생성이 있다. 기본으로 접고 네트워크는 최초 열기와 명시적 새로고침에서만 조회한다. 입력 문자열은 셸 구문으로 해석하지 않고 제한된 Docker API 요청 본문에 전달한다. Docker Hub 검색은 중지 상태에 엔진 의존성과 설정 바로가기를 표시하고, 접어도 검색 결과를 유지한다.

압축 지원은 Windows 내장 [CompactVirtualDisk API](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-compactvirtualdisk)를 우선한다. Hyper-V 모듈 누락으로 차단하지 않는다. Windows API로 VHDX 형식·동적 디스크·분리·식별 정보를 확인하며, 선택 방법과 디스크 ID도 승인 지문에 묶었다. 기존 소유권·관리자 권한·WSL 종료·배타적 파일 잠금·실행 직전 재검사는 유지한다. UI는 우선 해결할 조건을 표시하고 9개 검사 결과를 접는다. 실제 중지 상태에서 8개 통과, 관리자 권한만 차단됐으며 VHDX 크기·수정 시각은 검사 전후 같았다. 백업 입력·생성·검증은 요구하지 않는다.

| 최신 실제 Windows EXE 검사 | 결과 |
| --- | --- |
| `verify-image-run.mjs <port> --approved-isolated-fixtures <engine-id>` | 기본 실행 6개 통과. 실제 hello-world 생성·시작·종료 코드 0·CLI/UI 로그, 자동 Containers 이동, 전체 참조 수 갱신, 메뉴·대기 시 추가 조회 0회, 정확한 테스트 컨테이너 삭제. [결과](image-run-e2e.json). |
| 위 명령에 `--advanced` 추가 | 고급 설정 10개 통과. 실제 내부 전용 bridge 생성·선택, 환경 변수의 리터럴 값, CMD·ENTRYPOINT, 작업 경로, on-failure, 64MB, 0.5 CPU를 Docker inspect와 대조했다. 더보기·메뉴 이동·줄바꿈 입력 유지, 요청 시에만 네트워크 갱신, none 선택 시 포트 비움, 잘못된 설정 거부도 확인했다. [결과](image-run-advanced-e2e.json). |
| `verify-registry-search.mjs` / `verify-registry-collapse.mjs` | 8개와 1개 통과. 실제 Hub 검색·선택·입력 분리·객체 불변과 검색 결과 25개 접기·펼치기·보존·추가 조회 0회를 확인했다. [검색](registry-search-e2e.json), [접기](registry-collapse-e2e.json). |
| `verify-image-workflow-ui.mjs` / `verify-ui-prerequisites.mjs` | 4개와 8개 통과. 중지 안내·설정 이동·빌드 진입, 내장 API 검사, 상세 접기, 초기 snapshot 1회, 메뉴·대기 추가 조회 0회, 실제 드래그, 권한 확인 취소·미승인 거부와 중지 상태의 성공 배너 없음을 확인했다. [흐름](image-workflow-ui-e2e.json), [검사](ui-prerequisites-e2e.json). |
| 일반 앱 재실행 및 읽기 전용 진단 | exit 0. 디버깅 없는 일반 창, 원래 엔진 중지 상태, 같은 설치·기존 데이터 유지. [복원](restored-original-runtime-state.json), [일반 실행](final-normal-session.json), [진단](native-verification.json). |

검사 37개는 현재 EXE에서 수행했다. 테스트 컨테이너 2개와 새 내부 bridge 1개만 만들고 정확한 ID로 삭제했다. 기존 이미지·컨테이너·캐시·볼륨 사용량·네트워크 3개는 유지했다. 전체 prune, 기존 네트워크 변경, 실제 디스크 압축과 UAC 승인은 실행하지 않았다. 여러 컨테이너 간 DNS 통신과 CPU·메모리 부하 측정은 이번 검사에 포함하지 않았다. 이전 Dockerfile 빌드 6개와 전체 기능 23개는 당시 해시의 결과다. [현재 빌드별 검사 해시](standalone-build-verification.json), [이전 빌드](before-image-run/standalone-build-verification.json).

초기 검증 도구는 접힌 상세의 도움말을 진단으로 읽거나 기본 type이 submit인 폼 밖 닫기 버튼을 선택했다. 실제 생성 요청 전에 중단됐으며 범위를 지정한 선택자로 수정했다. 재실행 때 남은 접기 상태도 초기화했다. 제품 결과를 대체하거나 요청을 모의 처리하지 않았다. [최초 상세 선택자 오류](image-workflow-ui-first-harness-failure.json).

## 2026-10-17 Dockerfile 이미지 빌드 (28DD5627 빌드)

최신 Windows EXE는 3,701,760 B, SHA-256 `28DD56273C714E7F59E15EF155754A6606E3FD89CF7B063903D5A37D72949FA1`다. `.\scripts\desktop.ps1 -Mode build`는 exit 0, MSVC release 1분 56초로 완료됐다. `npm run build`, 오프라인 `cargo check --release`, `cargo fmt`도 통과했다. 새 의존성이나 lock 파일 갱신은 없고 새 REA MCP 호출도 0회다.

Images의 이미지 빌드에서 Windows 프로젝트 폴더·폴더 기준 Dockerfile·이미지 태그를 지정한다. 전용 WSL의 고정 Docker CLI로 `buildx build --builder default --load --progress=plain`을 실행한다. CLI 옵션과 소켓은 백엔드가 정하고 임의 명령은 받지 않는다. 소유권·Moby/API·엔진 ID를 확인하고 빌드 동안 검증 핸들을 유지한다. 로컬 경로와 Dockerfile 범위, 태그를 검증한다. Windows Docker Desktop CLI에는 의존하지 않는다. [공식 Buildx 옵션](https://docs.docker.com/reference/cli/docker/buildx/build/), [빌드 컨텍스트와 ignore 규칙](https://docs.docker.com/build/concepts/context/). 이번 구현은 DockSlate 독자 설계다.

진행 로그는 최근 1,048,576바이트까지 보관하며 로그 버전이 같으면 본문을 다시 보내지 않는다. 작업 중에만 상태를 조회하고 다른 메뉴로 이동해도 진행 상태를 유지한다. 완료·실패 후에는 전체 스냅샷을 갱신한다. 빌드 중 엔진 변경·삭제·정리·디스크 압축·앱 종료는 백엔드에서 차단한다. 진행 중 취소는 아직 지원하지 않는다.

| 실제 Windows EXE 검사 | 결과 |
| --- | --- |
| `node scripts/verify-image-build.mjs <DevToolsActivePort> --approved-isolated-fixtures` | 6개 통과. 한글·공백 폴더, 경로·태그 거부, 실제 Dockerfile 오류, 수정 후 재시도, 실행 중 로그, Buildx 결과 ID·라벨·실제 레이어의 COPY 파일과 .dockerignore 대조, 전역 화면 자동 갱신, 메뉴 왕복·대기 시 추가 조회 0회, 기존 데이터 보존. [결과](image-build-e2e.json). |
| 빌드 중 Settings 이동과 미승인 중지 요청 | UI 중지 버튼 비활성, 백엔드에서 이미지 빌드 진행 중 오류로 거부. 실제 엔진은 계속 실행됐으며 동일 ID를 확인했다. 위 E2E 결과의 activeBuildNavigation에 기록했다. |
| 최종 일반 실행과 `.\scripts\desktop.ps1 -Mode verify` | 디버깅 없는 일반 창 생성, 읽기 전용 진단 exit 0, 작업 전 중지 상태 유지. [복원](restored-original-runtime-state.json), [일반 실행](final-normal-session.json), [진단](native-verification.json). |

격리된 scratch 이미지 한 개만 빌드한 뒤 정확한 새 이미지 ID를 승인 경로로 삭제했다. 기존 hello-world 이미지와 컨테이너·캐시 ID는 보존했다. 테스트가 만든 캐시 4개는 유지했으며 전체 prune은 하지 않았다. 새로 만든 이미지를 컨테이너로 실행하는 검사는 이번 빌드 검사에 포함하지 않았다.

추가 네이티브 폴더 선택 검사에서 창 열기·취소·입력 편집 복귀를 확인했다. 이어서 검증 helper가 다른 프로세스의 포인터를 BFFM_SETSELECTIONW 메시지에 직접 전달했고 Windows SHCORE.dll 접근 위반으로 앱이 종료됐다. 이 메시지는 사용자 메시지 범위로 별도 마샬링이 필요하다는 [Microsoft SendMessage 문서](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessage)와 일치하므로 helper 오류로 진단했다. 해당 명령을 제거하고 앱을 다시 열었다. 폴더 선택 확정은 미검증이며 경로 직접 입력을 이용한 빌드 검증 6개는 보존한다. [추가 검사 오류](image-build-picker-harness-failure.json).

실제 디스크 압축과 관리자 UAC 재실행은 이번에도 실행하지 않았다. 이전 16개 UI 검사와 전체 기능 23개 검사는 아래의 이전 빌드 결과다. [당시 빌드와 검사 해시](before-image-run/standalone-build-verification.json), [이전 UI 빌드 기록](before-image-build/standalone-build-verification.json).

## 2026-10-16 검색 표시·드래그 선택·압축 검사 조치 (3769C75A 빌드)

최신 EXE는 3,637,760 B, SHA-256 `3769C75A5948380F3F6EA10FE7D2E07D6CB1AB5B6151B07CF9B18E629ACBA01D`다. `.\scripts\desktop.ps1 -Mode build`는 exit 0, Windows MSVC release 3분 2초로 완료됐다. 의존성과 lock 파일은 변경하지 않았다. 새 REA MCP 호출은 0회이며 이번 UI와 관리 명령은 DockSlate 독자 설계다.

Images에 Docker Hub 검색을 항상 표시한다. 검색 버튼을 눌러 결과를 조회하고 이미지를 선택하면 Pull 입력이 열린다. 로컬 필터·Hub 결과·태그는 메뉴 이동 시 유지한다. 메뉴·제목·버튼의 드래그 선택은 막고 입력·로그·표 데이터·경로·진단의 선택과 복사는 유지한다. Settings는 중지 상태를 회색으로 표시하며 정상 작업의 성공 배너를 남기지 않는다.

압축 검사에는 항목별 상태, 해결 안내, 관리자 재실행·Windows 기능 열기·재검사 버튼을 붙였다. 반복되는 경고 목록과 원본 진단은 접을 수 있다. `diskTools` 검사는 사용자 요청 시에만 실행하며 초기 스냅샷에는 추가하지 않았다. 이 PC의 실제 결과는 Get-DiskImage 사용 가능, Get-VHD·Optimize-VHD 없음이다. 중지 후 디스크 파일 잠금 검사는 통과했지만 도구·권한 조건이 충족되지 않아 압축 승인 토큰은 발급되지 않았다.

| 최신 실제 Windows EXE 검사 | 결과 |
| --- | --- |
| `node scripts/verify-registry-search.mjs <DevToolsActivePort>` | 8개 통과. 상시 검색 표시, 실제 공식 hello-world 결과, 입력의 실제 드래그 선택, 결과 선택·태그, 독립 로컬 필터, 메뉴 상태 유지, 잘못된 입력 거부, 실제 객체 불변. [결과](registry-search-e2e.json). |
| `node scripts/verify-ui-prerequisites.mjs <DevToolsActivePort>` | 8개 통과. 시작 스냅샷 1회, 메뉴 이동·6초 대기 중 추가 조회 0회, 실제 제목·부제·내비게이션 드래그 선택 방지, 경로·진단 선택, 실제 사전 검사 9개 행과 응답 대조, 행별 재검사, 권한 확인창 취소·미승인 요청 거부, 중지 상태의 성공 배너 없음. [결과](before-image-run/ui-prerequisites-e2e.json). |
| `.\scripts\desktop.ps1 -Mode verify` | exit 0. 중지 상태 유지, 승인 없는 관리자 재실행·삭제·압축·런타임 변경 거부. [결과](before-image-build/native-verification.json). |

관리자 재실행은 현재 EXE만 Windows runas로 실행하며 실행 파일·권한·프로세스·새 창을 확인한 뒤 기존 창을 닫는다. 새 관리자 창은 별도 WebView 프로필을 사용하고 상속된 WebView 디버깅 환경 변수를 제거한다. Windows 기능 버튼은 고정된 시스템 optionalfeatures.exe만 연다. 구현은 [Microsoft ShellExecuteExW 문서](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecuteexw)를 참고했다. 실제 UAC 승인·새 창 교체와 Windows 기능 창 실행·도구 설치는 검증하지 않았다. 기능 제공 여부는 [Microsoft의 Hyper-V 설치 조건](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v?pivots=windows&tabs=gui)에 따라 다르다.

첫 UI 검사 도구는 CDP에 DOM 요소를 값으로 반환해 중단됐다. 결과를 boolean으로 반환하도록 수정했으며 실제 검사 조건은 유지했다. [최초 도구 오류](ui-prerequisites-first-harness-failure.json). 같은 세션에서 엔진 중지 직후, 렌더러 재로드 전에도 중지 배지·Disconnected·성공 배너 0개를 확인했다.

검색 검증을 위해 시작한 전용 엔진은 사용자의 원래 중지 상태로 복원했다. 검증 창을 정상 종료하고 디버깅 옵션 없는 일반 앱을 다시 열었다. 백업 생성과 실제 VHDX 압축은 실행하지 않았다. [복원 기록](before-image-build/restored-original-runtime-state.json), [일반 실행](before-image-build/final-normal-session.json), [빌드와 검사별 해시](before-image-build/standalone-build-verification.json). 이전 전체 기능 23개 검사는 아래 F6CCE512 빌드의 결과이며 이번 변경에서 전체를 다시 수행하지 않았다.

## 2026-10-16 전체 새로고침·요청 지연 개선·백업 조건 제거 (F6CCE512 빌드)

이 빌드의 EXE는 3,611,136 B, SHA-256 `F6CCE512E922DF0775E2F0CA265924955E28F5C485CE0A4CBA5EEF7AC35C758D`다. `.\scripts\desktop.ps1 -Mode build`는 exit 0, Windows MSVC release 2분 5초로 완료됐다. 의존성과 lock 파일은 변경하지 않았다.

이전 빌드의 Docker GET 경로는 요청마다 PowerShell로 소유 런타임을 재검사했다. 이제 하나의 명령 동안 검증한 소유권 파일·기존 변경 잠금·keeper 핸들을 유지하고, 매 요청의 WSL 등록 정보·keeper 생존 상태는 Windows 네이티브 API로 확인한다. 실제 POST·DELETE 직전의 전체 소유권 검사와 승인 토큰·엔진 ID·선택 대상 재검증은 유지한다. 전체 스냅샷은 런타임 검사를 한 번 재사용하며, WSL 디스크와 Docker 목록·사용량을 가능한 범위에서 병렬 조회한다. 전역 신뢰 캐시나 소유권 검사 생략은 사용하지 않는다.

| 실제 IPC 단일 관측 | 이전 8C50904C 빌드 | 최신 F6CCE512 빌드 |
| --- | ---: | ---: |
| `dashboard_snapshot` | 6,345 ms | 1,586 ms |
| `images_list` | 5,527 ms | 1,632 ms |
| `destructive_preview` | 7,168 ms | 2,423 ms |

같은 PC·실행 중인 같은 독립 엔진에서 명령당 한 번 측정한 값이다. 통계적 벤치마크나 모든 환경의 지연 보장이 아니다. 최신 스냅샷은 런타임과 WSL 디스크도 포함한다. [변경 전 실측](backend-latency-before.json), [변경 후 실측](backend-latency-after.json).

모든 화면의 버튼은 **전체 새로고침**으로 통일했다. 시작·수동 갱신은 7개 결과를 스냅샷 한 번으로 받아 공유 캐시에 함께 반영한다. Pull·컨테이너 변경·삭제·정리 뒤에도 공유 결과를 갱신한다. 삭제 확인창은 먼저 열고 실제 참조 상태 검사는 뒤에서 수행하며, 검사 완료 전 승인 체크·실행을 차단한다. 검사 중 취소하면 늦은 결과를 버린다.

| 최신 Windows EXE 검증 | 실제 결과 |
| --- | --- |
| `node scripts/verify-global-refresh.mjs <DevToolsActivePort>` | 6개 통과. 시작 snapshot 1회, 메뉴·탭 이동과 대기 중 조회 0회. Images·Overview·Disk Manager·Settings 각 Refresh가 snapshot 1회만 호출하며 모든 헤더·데이터 함께 갱신. 확인창은 클릭 뒤 첫 RAF 7.5 ms에서 표시됐고 승인 비활성·늦은 응답 취소 확인. 이는 첫 프레임 DOM 관측이며 전체 paint 시간 측정은 아니다. [결과](global-refresh-e2e.json). |
| `node scripts/verify-independent-engine.mjs <DevToolsActivePort> --approved-isolated-fixtures .analysis/global-refresh-independent-e2e` | 23개 통과. 실제 Pull·컨테이너 제어·로그·삭제 보호·승인 삭제·선택 정리·Windows bind mount·localhost HTTP·엔진 중지/시작 확인. Pull·컨테이너 삭제·UI 선택 정리 후 수동 Refresh 없이 Overview·Images·Docker Usage의 일치 확인. 테스트 객체 제거, 기존 캐시 보존, renderer 예외 0개. [결과](independent-engine-e2e-final-build.json). |
| `node scripts/verify-runtime-recovery.mjs <DevToolsActivePort> --approved-owned-runtime-stop-start` | 6개 통과. 다른 메뉴에서 작업 중 상태·완료·자동 회복, 동일 엔진 ID와 기존 데이터 보존. [결과](runtime-recovery-e2e.json). |
| `node scripts/verify-final-state.mjs <DevToolsActivePort>` | 11개 통과. 실제 CLI/용량 대조, 백업 입력 없는 준비 화면, `requiresBackup=false`, 실행 중·권한 미충족 시 승인 토큰 미발급, 중지 승인 취소 확인. 압축 실행은 없음. [결과](final-native-state-verification.json). |
| `.\scripts\desktop.ps1 -Mode verify` | 최신 EXE의 연결 상태 진단 exit 0. 복원 후 중지 상태의 진단도 exit 0이며 자동 기동 없음. 승인 없는 변경 거부. [연결 시](native-verification-connected-final.json), [복원 후](before-ui-prerequisites/native-verification.json). |

사용자의 명시적 변경 지시에 따라 백업 파일 경로·생성·크기/SHA-256 대조를 요구하지 않는다. 최종 승인에는 백업 없이 원본 VHDX를 변경하며 앱에서 되돌릴 수 없다는 점을 표시한다. 소유권·WSL/런타임 종료·분리·배타적 잠금·관리자 권한과 승인 직전 재검증은 유지했다. 실제 WSL 디스크 압축은 수행하지 않았으며 성공으로 기록하지 않는다.

성능 측정을 위해 시작한 엔진은 작업 전 사용자가 두었던 **중지 상태**로 복원했다. 검증 창을 정상 종료하고 디버깅 인자 없이 일반 앱을 다시 열었으며, 앱 실행이 중지된 엔진을 자동으로 시작하지 않음을 확인했다. Windows UI와 WebView2 7개 프로세스의 관측 private commit 합계는 197,009,408 B다. WSL VM·엔진을 포함한 물리 RAM 사용량이나 이전 빌드와의 메모리 비교 지표는 아니다. [복원 기록](before-ui-prerequisites/restored-original-runtime-state.json), [일반 실행](before-ui-prerequisites/final-normal-session.json), [최신 빌드·검사별 해시](before-ui-prerequisites/standalone-build-verification.json). 새 REA MCP 호출은 0회다.

## 2026-10-16 이전 조회 캐시 빌드 — 8C50904C 기록

앱 시작 시 Rust의 `dashboard_snapshot` 한 번으로 엔진·컨테이너·이미지·Docker 사용량을 공유한다. 런타임 상태와 WSL 디스크도 시작 시 각각 한 번 조회한다. 다섯 메뉴와 두 디스크 탭은 마운트를 유지하므로 이동 시 기존 데이터·필터·입력을 바로 표시한다. 평상시 엔진·런타임 폴링은 제거했고, 수동 새로고침은 현재 화면 데이터만 갱신하며 기존 내용을 유지한다. 승인한 작업의 완료 추적과 활성 로그 화면의 갱신은 유지한다. 이는 DockSlate 독자 설계이며 새 REA 호출은 없다.

| 실제 Windows EXE 검증 | 결과 |
| --- | --- |
| `node scripts/verify-navigation-cache.mjs <DevToolsActivePort>` | 6개 통과. 시작 시 `dashboard_snapshot`·`runtime_status`·`wsl_inventory` 각 1회, 별도 Docker 목록 조회 0회. 메뉴·탭 3회 왕복과 16초 대기 중 추가 데이터 IPC 0회. 클릭 후 첫 프레임의 상태·DOM·실측 값 유지 확인. Images 새로고침은 `engine_status`·`images_list` 각 1회이며 조회 중 기존 데이터 유지. [원시 결과](navigation-cache-e2e.json). |
| `node scripts/verify-registry-search.mjs <DevToolsActivePort>` | 실제 Docker Hub 검색 7개 통과. 공식 hello-world 결과·선택·명시적 latest 태그, 로컬 필터와 독립 동작, 메뉴 이동 후 상태 유지, 잘못된 입력 거부, 객체 불변 확인. [원시 결과](before-ui-prerequisites/registry-search-e2e.json). |
| `node scripts/verify-final-state.mjs <DevToolsActivePort>` | 읽기 전용 10개 통과. 실제 CLI와 4종 사용량 대조, 십진 단위와 VHDX 파일 크기 대조, 정리 바로가기, 압축 준비 안내·중지 승인창 취소·압축 차단 확인. [원시 결과](before-global-refresh/final-native-state-verification.json). |
| `node scripts/verify-runtime-recovery.mjs <DevToolsActivePort> --approved-owned-runtime-stop-start` | 6개 통과. 실제 Settings 승인 뒤 다른 메뉴에서 DOM만 관측해 중지·작업 중·자동 재연결 확인. 기존 이미지 ID·태그, 캐시와 엔진 ID 보존. [원시 결과](before-global-refresh/runtime-recovery-e2e.json). |
| `node scripts/verify-independent-engine.mjs <DevToolsActivePort> --approved-isolated-fixtures .analysis/final-independent-engine-e2e` | 최신 빌드의 실제 기능 E2E 21개 통과, renderer 예외 0개. Pull·컨테이너 제어·로그·보호 조건·승인 삭제·선택 정리·Windows bind mount·localhost HTTP·런타임 재시작 확인. 테스트 객체 제거 후 기존 hello-world 이미지와 캐시 보존. [최신 빌드 결과](before-global-refresh/independent-engine-e2e-final-build.json). |
| `.\scripts\desktop.ps1 -Mode build` | TypeScript·Vite 및 Windows MSVC release exit 0. Rust release 1분 58초. EXE 3,590,656 B, SHA-256 `8C50904C6A9B41A4DA2D293619AE8BF74BED065F37252C86C3C99F69DF69C273`. |
| `.\scripts\desktop.ps1 -Mode verify` | exit 0. 자체 엔진 connected, 런타임 running. 승인 없는 삭제·압축·런타임 변경 거부. [원시 결과](before-global-refresh/native-verification.json). |

검증 창을 정상 닫은 뒤 디버깅 인자·별도 WebView 프로필 없이 일반 실행했다. 정상 창 생성과 같은 엔진 ID `12f63594-ea3a-45f9-adf2-c594dc91cbc5` 유지를 확인했다. 일반 실행 중 Windows 앱과 WebView2 총 7개 프로세스의 private commit 합계는 관측 시점 204,845,056 B(약 204.8 MB)였다. 물리 RAM 사용량이나 WSL VM·Docker 엔진을 포함한 전체 제품 메모리 측정치로 해석하지 않는다. 메모리 기록 도구의 딕셔너리 속성 집계 오류는 일반 실행 성공 후 발생했으며, 추가 실행 없이 기존 일반 창을 측정해 기록을 복구했다. 원래 종료 코드는 보존하지 못해 `null`로 기록했다. [일반 실행·메모리 원시 결과](before-global-refresh/final-normal-session.json), [최종 빌드와 검사별 해시](before-global-refresh/standalone-build-verification.json).

Docker Hub 검색 검증은 기능이 동일한 직전 빌드 `6A658251…`에서 수행했다. 최신 빌드는 용량 단위 안내의 깨진 문자열만 수정했으며, 캐시 6개와 읽기 전용 10개 검증은 위 `8C50904C…` 빌드로 수행했다. 최초 검색 검사 도구가 Tauri 문자열 오류를 보존하지 못한 실패는 [별도 기록](registry-search-first-harness-failure.json)에 보존했다. 실제 검증 조건을 완화하지 않고 오류 전달을 수정해 다시 확인했다.

10월 16일 재실행 시 엔진이 중지돼 있어 캐시 검사 전제 조건에서 중단했다. 소유권을 확인한 후 기존 승인 범위의 UI 시작 절차로 엔진을 시작했다. 이후 발견한 `hello-world:latest` 이미지는 보존했다. 빈 엔진을 전제로 한 런타임 재검증은 변경 작업 전에 중단했고, 현재 이미지 ID·태그를 보존하도록 검사 도구를 조정했다. [시작 기록](before-ui-prerequisites/resumed-owned-engine-start.json), [조회 전제 조건](navigation-cache-stopped-precondition.json), [이미지 전제 조건](runtime-recovery-nonempty-precondition.json).

용량은 1,000 기준 KB·MB·GB이며 Docker 논리 사용량·정리 추정치·VHDX 크기는 구분한다. WSL 압축 준비 패널은 소유 엔진 중지 승인, 기존 별도 백업의 크기·SHA-256 검사, 관리자 권한과 Windows 도구 지원을 안내한다. 백업을 자동 생성하거나 관리자 권한을 자동 획득하지 않는다. 실제 WSL 디스크 압축은 실행하지 않았고 조건 미충족 시 계속 차단한다. Settings의 CPU·메모리 제한이나 자동 시작 설정은 이번 구현에 추가하지 않았다.

## 2026-10-15 독립 엔진·Docker Desktop 제거 후 확인

사용자의 승인으로 `DockSlate` WSL 2 배포판을 `D:\Program Files\DockSlate\runtime\wsl`에 설치했다. 공식 Ubuntu 24.04.5 rootfs, 서명된 APT 메타데이터와 고정 패키지 해시를 검증한 실제 설치다. 앱은 Docker Desktop/Rancher Desktop 실행 파일·CLI·엔진을 사용하지 않고 `wsl://DockSlate/var/run/docker.sock`에 연결한다. Moby 29.8.2 / API 1.55, Buildx 0.38.0과 Compose CLI 5.6.0의 실제 응답을 확인했다.

| 실제 실행 | 확인 결과와 원시 기록 |
| --- | --- |
| `node scripts/provision-runtime.mjs <DevToolsActivePort> --approved-install-and-start` | 전용 런타임 설치·시작 후 소유권·유지 프로세스와 엔진 연결 확인. [결과](independent-runtime-provisioning.json). |
| `node scripts/verify-independent-engine.mjs <DevToolsActivePort> --approved-isolated-fixtures` — Desktop 제거 전 | 실제 Windows EXE/WebView2 → Rust → 자체 Moby 경로 검사 21개 통과. [제거 전 결과](independent-engine-e2e-before-desktop-removal.json). |
| 별도 승인된 Docker Desktop 공식 제거기 실행 | Docker Desktop 4.57.0 공식 제거기 exit 0. 등록·서비스·실행 파일 제거, 소유 `main\ext4.vhdx`와 `disk\docker_data.vhdx` 모두 공식 제거기로 제거. [제거 결과](docker-desktop-removal.json). |
| `node scripts/verify-build-cache.mjs <DevToolsActivePort> --approved-isolated-fixtures` — Desktop 제거 후 | 격리된 scratch 이미지 두 개를 실제 Buildx로 빌드한 뒤 앱에서 선택한 캐시 ID 하나만 삭제. 선택하지 않은 ID 전부 보존, 검사 3개 통과. [결과](build-cache-e2e.json). |
| `node scripts/verify-independent-engine.mjs <DevToolsActivePort> --approved-isolated-fixtures .analysis/after-desktop-removal-e2e` — Desktop 제거 후 | 같은 실제 기능 검사 21개 재통과, renderer 예외 0개. [제거 후 결과](independent-engine-e2e-after-desktop-removal.json). |

21개 검사에는 실제 이미지 Pull·digest 확인, 컨테이너 목록·Compose 그룹 표시·시작·재시작·중지·stdout/stderr 로그·승인 삭제, 사용 중 이미지·실행 중 컨테이너 삭제 차단, 단일 사용 승인 토큰, 선택 이미지 정리, Overview 실측 개수가 포함된다. 작업 공간의 읽기 전용 Windows 파일을 mount한 컨테이너에서 동적 loopback 포트로 제공한 HTTP 응답도 Windows localhost에서 확인했다. 실제 런타임 중지·시작 후 엔진 ID `12f63594-ea3a-45f9-adf2-c594dc91cbc5`가 유지됐으며, Desktop 제거 전후에도 동일했다. Compose 파일 배포 기능을 검증한 것은 아니다.

제거한 Desktop VHDX의 파일 길이는 각각 109,051,904 B와 20,675,821,568 B였다. 제거 전후 C: 여유 공간은 332,335,935,488 B → 354,703,241,216 B, 관측 차이는 22,367,305,728 B였다. 이는 해당 시간 구간의 Windows 여유 공간 변화이며 Docker 정리 추정치나 VHDX 길이, 제거기 단독 회수량과 동일시하지 않는다. VHDX 직접 삭제 코드는 실제 디스크에 실행하지 않았다. 앱에 Desktop 자동 제거 기능을 추가한 것이 아니라 사용자가 별도로 승인한 일회성 공식 제거 작업이다.

테스트 컨테이너와 이미지는 승인된 정확한 대상으로 정리했다. 선택하지 않은 소량의 테스트 빌드 캐시와 작업 공간 증거 파일은 보존했다. 다른 배포판을 변경하거나 전역 `wsl --shutdown`을 실행하지 않았다. 원본 [REA 기록·Evidence](../research/rancher-desktop-1.24.0.md)는 보존했고, 이 구현에서 새 REA MCP 호출은 0회다. [공식 입력 근거](standalone-runtime-evidence.md), 실제 실행 관찰, DockSlate 독자 설계를 구분한다.

### 작업 중 차단·자동 회복 수정과 중간 빌드

Settings에만 있던 런타임 완료 추적을 앱 전체로 옮겼다. 이전에는 화면을 이동하면 완료된 작업의 `ACTIVE` 차단이 남을 수 있었다. Docker 연결 조회에서도 종료된 작업을 회수하며, 실제 진행 중 상태는 `busy` / `작업 중`으로 표시한다. 런타임 상태 변화 후 엔진과 화면 데이터를 자동 재조회한다. Overview의 이전 응답이 현재 연결 상태를 덮어쓰지 않도록 수정했다.

`node scripts/verify-runtime-recovery.mjs <DevToolsActivePort> --approved-owned-runtime-stop-start`의 실제 검사 6개가 통과했다. Images에서 중지, Containers에서 시작한 뒤 관측 중에는 테스트 도구가 상태 IPC·CLI·새로고침·화면 이동을 호출하지 않았다. 앱 자체가 작업 중 표시와 중지·연결 완료를 반영했고 이전 조회 오류가 해소됐다. 엔진 ID, 등록 소유권과 선택하지 않은 캐시를 보존했다. [원시 결과](runtime-recovery-e2e.json).

새 API 집계 객체의 생략된 0값을 처리해 이미지가 없는 엔진의 크기가 `미확인`이 되는 문제를 수정했다. `node scripts/verify-final-state.mjs <DevToolsActivePort>`의 읽기 전용 검사 5개가 통과했다. 이미지·컨테이너·볼륨·빌드 캐시 사용량을 실제 Docker CLI와 대조했고, Overview는 `0 / 0 / 48.1 KiB / 48.1 KiB`를 표시했다. 마지막 두 값은 남겨 둔 테스트 캐시의 논리 사용량과 정리 추정치다. 소유 VHDX는 D 경로의 실제 파일 2,497,708,032 B였고 압축은 차단됐다. [원시 결과](final-native-state-verification.json).

`.\scripts\desktop.ps1 -Mode build`가 exit 0, Rust release 2분 21초로 완료됐다. 당시 EXE는 3,571,200 B, SHA-256 `4951B6AD008C1E559836B38DDC57B09A0112BA44A9D4BAE1DFD08924BFF246B9`다. 첫 시도는 정상 닫기 후 남은 검증 UI 프로세스가 기존 EXE 교체를 막아 실패했다. 창·WebView·자식 프로세스가 없고 런타임 작업 완료를 확인한 뒤 해당 UI 프로세스만 정리하고 재빌드했다. 엔진은 유지했다. [프로세스 복구 기록](closed-native-process-recovery.json). 이는 10월 16일 조회 성능 개선 이전 빌드의 기록이다.

실제 WSL VHDX 압축은 실행하지 않았고 안전 조건 미충족 시 차단한다. 기존 Desktop 데이터 이관, Windows 파일 감시·쓰기 권한·대소문자 동작 전체도 검증하지 않았다.

## 2026-10-14 설치 전 기록

아래는 WSL 생성 예외 승인과 실제 설치 전의 스냅샷이다. 당시의 미설치 상태·경로·빌드 해시·미검증 목록을 보존하며 현재 상태와 구분한다. 현재 설치 위치와 실행 결과는 위 10월 15일 기록을 따른다.

2026-10-14. 사용자의 목표는 Docker Desktop 제거 후 독립 사용이다. 기존 Rancher 연결 클라이언트를 DockSlate 전용 WSL 2 Moby 엔진을 설치·시작·중지하는 구조로 변경했다.

### 구현과 실제 확인

- Rust가 고정된 `DockSlate` 배포판, 소유 마커, WSL 등록 ID·실제 경로, 유지 프로세스, Linux Moby API·엔진 ID를 검증한다. 관리 API는 전용 배포판의 Unix socket을 사용한다. Docker Desktop/Rancher Desktop의 실행 파일·CLI·엔진을 연결 대상으로 사용하지 않는다.
- 설치 미리보기는 `%LOCALAPPDATA%\DockSlate\runtime\wsl`과 새 배포판, 고정 Ubuntu·Engine 패키지, 별도 데이터 저장소, 다운로드·설치 영향을 표시한다. 설치·시작·중지에는 명시적인 승인이 필요하다. 실패한 설치를 자동 삭제하거나 기존 배포판을 재사용하지 않는다.
- 엔진 설치 전에는 `not_installed` / `unavailable`, 사용량 `null`을 반환한다. WSL 디스크 조회는 기존 등록과 크기를 읽고, 검증되지 않은 압축은 차단한다.

| 실제 실행 | 결과 |
| --- | --- |
| `.\scripts\desktop.ps1 -Mode build` | TypeScript·Vite와 Windows MSVC release 빌드 exit 0. Rust release 1분 45초. Vite 44 modules, JS 287.61 kB, CSS 21.41 kB. |
| `.\scripts\desktop.ps1 -Mode verify` | 최종 EXE 진단 exit 0. 독립 엔진 미설치, 설치 미리보기 eligible=true, 승인 없는 설치·시작·중지·삭제·압축 거부. [당시 원시 결과](standalone-preinstall-native-verification.json). |
| `node scripts/verify-native-ui.mjs <DevToolsActivePort> .analysis/standalone-final-ui native` | 실제 EXE/WebView2 메뉴·오프라인 상태·WSL 조회·두 창 크기·renderer 예외 검사 11개 통과. [원시 결과](standalone-native-ui-verification.json). |
| `node scripts/verify-native-ipc.mjs <DevToolsActivePort>` | 실제 WebView2 → Rust IPC 검사 5개 통과. 미설치 엔진, 알 수 없는 사용량, 승인 없는 삭제·압축과 잘못된 Pull 차단. [원시 결과](native-ipc-verification.json). |
| `node scripts/verify-runtime-setup-ui.mjs <DevToolsActivePort>` | 실제 설치 미리보기·대상·버전·승인·긴 대화상자·취소 검사 6개 통과. 승인 체크박스와 실행 버튼을 누르지 않았다. 취소 후 배포판 미설치 유지. [원시 결과](standalone-runtime-ui-verification.json). |
| 최종 EXE 종료 | 검증 인스턴스의 정상 창 닫기로 exit 0. 기존 런타임 프로세스를 종료하지 않았다. |

당시 실행 파일은 `src-tauri/target/release/dockslate.exe`, 3,568,640 B였다. SHA-256은 `D6DEB8DAACF4B7AB9ADFBF8FCCC6B24B8E53FB3955A548013C06A01C2CE395B1`이다. 현재 최종 빌드의 해시로 간주하지 않는다. 최초 검증 시 WebView 페이지 생성 전에 접속해 실패한 검사 도구는 페이지 준비를 기다린 뒤 재실행했다. GUI 결과 JSON의 복사 경로 오류는 실제 `verification.json` 경로로 바로잡았다.

### WSL 호출 버그와 수정 근거

초기 PowerShell 호출이 모든 WSL 옵션을 따옴표로 감쌌다. 실제 재현에서 `"--list" "--running" "--quiet"`가 관리 옵션으로 처리되지 않아 기존 기본 `docker-desktop` 배포판의 기동을 시도했다. 이 기동은 기존 VHDX 잠금 오류 `Wsl/Service/CreateInstance/MountDisk/HCS/ERROR_SHARING_VIOLATION`으로 실패했다. 진단 중 이 경로를 실행한 사실을 기록하며, 기동 시도 자체가 없었다고 주장하지 않는다. 성공한 기동이나 데이터 변경은 관찰하지 않았다.

공백·따옴표가 없는 인자를 그대로 전달하도록 수정했다. 수정 후 실제 Windows에서 `wsl --version`, `wsl --list --verbose`, `wsl --list --running --quiet`가 exit 0으로 동작했다. WSL 2.6.3이며 실행 중 배포판 목록은 비어 있었다. 최종 EXE 진단에서도 같은 결과를 확인했다. 기존 `docker-desktop`은 정지 상태, VHDX 길이는 109,051,904 B(104 MiB)다. 기존 VHDX의 잠금을 해제하거나 mount·detach·압축하지 않았으며 전역 `.wslconfig`도 변경하지 않았다.

### 당시 미실행·미검증

기존 사용자 지시의 WSL 배포판 생성 금지에 대한 예외 승인 전이므로 `DockSlate` 배포판 생성, Ubuntu 다운로드·import, apt 설치, 엔진 시작·중지·연결, 실제 컨테이너·이미지·로그·선택 정리 E2E는 실행하지 않았다. 구현 코드와 승인 화면 검증만으로 이 기능들을 완료 처리하지 않는다.

설치·연결 후에도 Windows localhost 게시 포트, Windows 파일 bind mount, Buildx/Compose CLI, 재시작 지속성, 새 DockSlate 디스크 등록·크기를 실제로 확인해야 한다. 실제 WSL 디스크 압축과 Docker Desktop 제거, 기존 데이터 이관은 수행하지 않았다. 독립 엔진 MVP는 아직 미완료다.
