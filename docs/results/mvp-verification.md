# DockSlate MVP 검증

이 문서는 기존 Rancher 연결 클라이언트의 검증 기록이다. Docker Desktop 제거 목표에 맞춘 최신 독립 엔진 구현·실행 결과는 [별도 검증 기록](standalone-runtime-verification.md)에 있다. 기존 클라이언트의 native JSON은 [보존 파일](client-native-verification.json)로 연결한다.

검증 대상은 DockSlate 자체 Windows 실행 파일이다. 원본 Rancher Desktop, 기존 Docker 객체, 실제 WSL 디스크를 변경하지 않는다. 기존 REA 보고서는 보존하며 새 근거는 [Docker 백엔드 추가 근거](docker-backend-evidence.md)에 분리한다.

실행 전 정의한 실패 조건:

- Rancher Desktop이 없는데 엔진 연결 완료·측정 숫자·객체 목록을 표시하면 실패한다.
- Docker Desktop의 named pipe를 Rancher Moby로 허용하면 실패한다.
- 엔진 미연결 상태에서 Pull·삭제·정리를 실행할 수 있으면 실패한다.
- 승인 없는 삭제·압축, 미등록 VHDX ID, 불명확한 사전 조건이 실행으로 이어지면 실패한다.
- 실제 Tauri 창의 메뉴가 비어 있거나 renderer 예외가 발생하면 실패한다.
- 1000×640 및 1200×780에서 기본 메뉴·상태 확인이 불가능하면 실패한다.

엔진 연결 후 컨테이너·이미지 변경 및 VHDX 압축 성공 경로는 격리된 데이터와 별도의 명시 승인 없이 실행하지 않는다. 현재 검증 결과는 실행 후에만 아래에 추가한다.
# 실제 실행 결과

2026-10-13~14 Windows 환경. 재시도의 CIM 조회에서 Microsoft Windows 11 Home, build 26300을 확인했다. Rancher Desktop Moby 설치는 발견되지 않았다. 10월 13일에는 Docker Desktop 프로세스·WSL 배포판이 실행 중이었으며, 14일 최종 조회에서는 실행 중 런타임·배포판이 없었다. 해당 엔진 API는 연결 대상으로 사용하지 않았다. Docker 데이터 변경, WSL 생성·종료, 디스크 mount·detach·압축은 수행하지 않았다.

| 검증 | 결과·범위 |
| --- | --- |
| `npm install` | 승인된 필수 의존성 설치·lock 생성 성공. |
| `npm run build` | TypeScript 검사와 Vite 배포 빌드 성공. 43 modules, JS 279.19 kB, CSS 21.26 kB. |
| Rust·MSVC 도구 | 로컬 Rust 1.99.0/Cargo 1.99.0과 Microsoft 서명이 검증된 C++ Build Tools/SDK 설치 성공. rustfmt 1.10.0 설치·서식 적용 성공. 초기 자동 승인 검토 사용량 한도 실패는 정상 승인 검토 재시도로 해소했다. |
| Windows Docker Rust 백엔드 | 실제 `docker.rs`/`pipe.rs`/`process.rs`를 별도 검증 실행 파일에 링크하여 컴파일·실행. Engine `unavailable`, Overview 카운터·용량 `null`, 목록·사용량 실패 이유, 승인 없는 삭제·빈 선택·잘못된 동작/Pull 차단 확인. [원시 결과](docker-native-verification.json). 전체 Tauri 앱 검증은 아니다. |
| WSL 탐색 | 초기 제한 환경에서는 관련 Lxss 등록 0건 및 WSL 목록 exit -1을 관찰했다. 샌드박스 밖 제품 EXE에서는 실제 `docker-desktop` WSL 등록, Docker Desktop 소유 경로와 VHDX 파일 길이 109,051,904 B(104 MiB)를 읽기 전용으로 조회했다. 13일에는 실행 중 배포판·런타임도 압축을 차단했다. 14일에는 런타임이 종료된 상태였으나 admin=false, 분리·백업 미확인으로 계속 차단됐다. [초기 결과](wsl-inventory-verification.json), [제품 EXE 최종 결과](client-native-verification.json). |
| 압축 차단 | 없는 디스크·빈 백업으로 preview 실행. 소유·권한·WSL·런타임·분리·잠금·백업 조건 실패 및 eligible=false 확인. 원본 VHDX 접근·변경 없음. [원시 결과](wsl-blocked-preview-verification.json). |
| 파일 할당 API | 고정 스크립트의 C# native helper 컴파일·실행. 자체 아이콘의 파일 길이 41,086 B, Windows 할당 45,056 B, 파일 ID 조회. 읽기 전용이며 VHDX 테스트가 아니다. [원시 결과](file-allocation-verification.json). |
| 브라우저 UI | 배포 frontend를 Vite preview와 전용 Chrome 임시 프로필에서 실행. Tauri 없음 오류, 5개 메뉴, offline 이미지 작업 비활성화, WSL 백엔드 없음 오류, 1200×780·1000×640 가로 넘침 없음, renderer 예외 0건 확인. 11개 점검 통과. 모의 backend·데이터 주입 없음. [원시 결과](frontend-ui-verification.json). native 앱·성공 데이터 화면·승인 dialog E2E는 아니다. |
| 전체 Windows 제품 빌드 | 초기 두 번은 sandbox 밖을 포함해 Windows 오류 5로 실패했다. 이번 재시도에서도 sandbox 안은 `web_atoms/local_names.txt` 읽기 오류 5, exit 1. 같은 `.\scripts\desktop.ps1 -Mode build`를 sandbox 밖에서 다시 실행해 release 빌드 exit 0, 3분 23초, `src-tauri/target/release/dockslate.exe` 생성 성공. 보호 제품·조직 정책 여부와 과거 실패 원인은 여전히 미확인이다. 접근 제어 설정이나 의존성 원본은 변경하지 않았다. |
| 제품 EXE 진단 | `.\scripts\desktop.ps1 -Mode verify`를 실제 제품 EXE로 실행, exit 0. Rancher 부재 `unavailable`, 목록·사용량 조회 실패, 잘못된 Pull·승인 없는 삭제/압축·미등록 디스크 차단 확인. 마지막 기록은 sandbox 밖 실행 결과이다. [원시 결과](client-native-verification.json). |
| 제품 GUI 및 재실행 | 실제 release EXE와 WebView2에서 5개 메뉴, 미연결 오류, Pull 비활성화, WSL 등록·크기·압축 차단, 두 화면 크기와 renderer 예외 0건 확인. 최초 실행과 별도 임시 프로필 재실행에서 각각 11개 점검 통과. 재실행 인스턴스는 정상 창 닫기로 exit 0. [최초 결과](native-ui-verification.json), [재실행 결과](native-ui-relaunch-verification.json). |
| 제품 Tauri IPC | `node scripts/verify-native-ipc.mjs <DevToolsActivePort>`로 실제 WebView2→Rust 호출. 엔진 `unavailable`, Overview의 5개 수치 `null`, 승인 없는 삭제/압축과 잘못된 Pull 거부를 확인했다. 5개 점검 통과. [원시 결과](native-ipc-verification.json). |
| 개발 서버 | 초기 sandbox 실행은 esbuild JS 읽기 접근 거부. 이번 sandbox 밖에서는 의존성 변환을 통과했으나 `.analysis` 파일 감시에서 EBUSY로 종료했다. `vite.config.ts`에서 분석·도구·Rust·검증 디렉터리를 감시 제외한 뒤 `npm run dev`와 모듈 HTTP 응답 10개 점검 통과. 분석 파일 생성 후에도 서버 유지. native `desktop:dev`는 미검증. [원시 결과](dev-server-retry-verification.json). |
| 10월 14일 최종 제품 | Vite 감시 수정 후 `.\scripts\desktop.ps1 -Mode build` release 2분 11초, exit 0. 새 EXE로 읽기 전용 진단, GUI 11개 및 IPC 5개 점검을 다시 통과하고 정상 종료 exit 0. [파일 해시·명령 결과](windows-build-retry.json), [최종 GUI 결과](native-ui-final-verification.json). |

제품 EXE 크기는 3,481,600 B(3.32 MiB)이다. 14일 최종 EXE SHA-256은 `9950A5487FF102D24E361D508FDF5E8AA0573B8E13EB1A7E84E2925B1C4270D2`이며 [최종 파일 기록](windows-build-retry.json)에 연결했다. 메모리는 13일 EXE(`F718BADB576C17BDFE1BDBFD6E7876D63805BBF1E24DF464E6FCA523BAD82FB6`)의 WebView2 디버깅을 켠 미연결 Overview에서 한 번 측정했다. Rust 호스트 working set은 24,702,976 B, 호스트와 소유 WebView2 자식 6개의 private bytes 합계는 230,215,680 B였다. working set 합계 398,983,168 B는 공유 페이지를 중복 계산할 수 있다. 연결된 엔진 작업 부하·설치 프로그램 크기는 측정하지 않았다. EXE 크기는 설치된 WebView2와 생성 프로필을 제외한다. [측정 원시 결과](native-runtime-measurement.json).

Windows 제품 빌드·GUI 실행·재실행과 미연결/차단 경로는 검증했다. 연결된 Moby 엔진과 압축 성공 경로를 확보하지 못했으므로 MVP 전체 완료로 처리하지 않는다. 기존 REA 기록은 보존했고 이번 재시도에서 새 REA MCP 호출은 0회이다.

Rancher Desktop Moby가 없어 성공 연결·컨테이너 목록/시작/중지/재시작/로그/삭제·이미지 Pull/삭제·사용 중 이미지 차단·Compose 그룹·사용량/선택 정리 E2E는 실행할 수 없다. Docker Desktop VHDX의 등록·경로·파일 크기 조회와 압축 차단은 확인했지만 Rancher VHDX 조회 및 압축 성공 E2E는 미검증이다. 검증 백업·런타임 종료·분리 상태·관리자 권한·Hyper-V 지원 조건을 확보하지 않았다. 실제 WSL 디스크에 대한 파괴적 테스트는 하지 않았다.
