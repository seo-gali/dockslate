# 설치·Windows Docker 통합 검증

Docker Desktop처럼 앱 설치 과정에서 내부 Linux 엔진과 Windows Docker 명령을 함께 준비한다. 기존 WSL·이미지·볼륨을 유지하며 별도 Linux 배포판을 사용자가 설치하는 과정을 요구하지 않는다. 사용자 설치에서 발견된 긴 PATH 오류를 수정한 EXE를 별도 Windows 빌드로 생성하고 공식 GitHub digest와 내부 EXE 해시를 대조했다. 수정판은 자동 실행하지 않았으며 전체 설치·제거 완료는 미검증이다.

완료 기준은 설치 파일 하나로 앱·Windows CLI를 설치하고, 승인한 Docker Engine을 준비한 뒤 새 터미널의 `docker`·`docker compose` 사용을 실제 확인하는 것이다. ZIP 생성과 개별 CLI 검증은 이 결과를 대신하지 않는다.

로컬 설치기 빌드의 같은 입력 오류를 최신 EXE로 재현했다. 사용자 승인으로 `seo-gali/dockslate`의 `build/installer` 브랜치에서 별도 Windows 빌드를 사용한다. [워크플로](../../.github/workflows/installer.yml)는 고정한 공식 GitHub Actions 3개와 기존 빌드 스크립트로 설치 EXE·SHA-256만 산출물로 올린다. 앱·설치 파일은 자동 실행하지 않으며 실제 원격 실행 결과는 별도로 확인한다.

## 구성

| 구성 요소 | 구현과 현재 상태 |
| --- | --- |
| Linux Docker Engine | 기존 DockSlate 소유 WSL 2 엔진 재사용. 새 PC에서는 승인한 대상에 고정 버전 Engine 29.8.2·Buildx 0.38.0·Compose 5.6.0을 온라인 설치 |
| Windows 명령 | 공식 Windows Docker CLI 29.8.2·Compose 5.6.0·Buildx 0.38.0과 라이선스 다운로드·해시 검증·libexec 배치 완료 |
| Windows 연결 | 현재 사용자 SID 전용 named pipe와 별도 broker. 기존 Rancher pipe 클라이언트와 WSL 명령별 경로 재작성 런처를 교체 |
| 프로필 | 현재 사용자 DockSlate CLI 전용 경로. 다른 Docker 설정·인증 정보를 복사하거나 installer에서 읽지 않음 |
| 배포 | 앱·bin·libexec·라이선스를 포함하는 설치판·포터블 ZIP. 포터블은 최신 통합 빌드 기록의 앱·launcher 해시와 각 구성 요소 해시를 검사하고 실행 미검증 여부를 함께 표시. 단독 앱 EXE는 전체 CLI 구성을 제공하지 않음 |

Windows CLI는 Windows 파일과 환경 변수를 사용한다. 컨테이너 생성 API의 bind source 두 양식만 실제 WSL 경로로 변환한다. named volume·컨테이너 target·환경 변수는 보존한다. UNC·drive-relative 경로 등 미지원 입력은 거부한다. broker의 수명·유휴 제한과 외부 장기 연결 중 런타임 중지 제한은 [CLI 계약](windows-cli-contract.md)에 기록했다. 완전한 Docker Desktop 기능·SDK 호환성을 검증했다는 의미는 아니다.

## 설치 완료 조건

### 긴 PATH에서 설치 중단

사용자 설치에서 `PATH could not be read without truncation` 오류가 확인됐다. 이 PC의 사용자 PATH는 1,199자이며 기존 설치기의 NSIS 문자열 한도는 1,024자다. 엔진은 별도 WSL에서 정상 실행되더라도 이 단계에서 설치가 중단되면 Windows `docker` 명령은 등록되지 않는다.

PATH 원문을 NSIS 변수에 담지 않고 Windows의 .NET 레지스트리 API로 처리한다. 등록·재설치·제거에서 기존 문자열, 환경 변수 표기, 레지스트리 형식을 보존한다. 제거는 설치기가 추가한 경로만 대상으로 한다. Windows PowerShell 5.1에서 `scripts/verify-installer-path.ps1` 종료 0: 1,199자·10,000자·빈 값·미등록 값의 왕복, 재설치, 이후 추가 경로 보존, 소유권·형식·길이 제한과 실제 설치 명령의 읽기 전용 조회를 확인했다. 실제 사용자·시스템 PATH와 엔진 데이터는 변경하지 않았다. 전체 설치·제거 완료는 별도 확인이 필요하다.

NSIS의 [ReadRegStr 제한](https://nsis.sourceforge.io/Reference/ReadRegStr)과 .NET의 [환경 변수 원문 읽기](https://learn.microsoft.com/en-us/dotnet/api/microsoft.win32.registrykey.getvalue?view=net-10.0)를 기준으로 처리한다. 새로운 의존성이나 PowerShell 실행 정책 변경은 없다.

화면의 실제 여부도 다시 확인했다. 소유권을 확인한 기존 엔진에 직접 요청한 `info`, `ps -a`, `images`는 종료 0이며 Engine 29.8.2, `trusting_feistel`, `mongo:latest`가 화면과 일치했다. Windows TCP 연결은 32768 성공·27017 실패다. 해당 컨테이너의 Compass 접속 주소는 `mongodb://127.0.0.1:32768`이다. 데이터베이스 내용은 조회·변경하지 않았다.

1. 앱·Windows CLI·현재 사용자 PATH를 준비하고 엔진 설치 대상을 자동 확인한다.
2. 기존 엔진의 소유권을 확인해 재사용한다. 새 설치·시작은 대상과 영향을 표시한 승인 뒤 진행한다.
3. 레지스트리의 시스템·사용자 PATH를 반영한 새 터미널에서 설치한 docker가 선택되는지 검사한다. 다른 Docker 경로가 앞서면 충돌을 표시하고 완료를 차단한다.
4. Windows CLI의 engine ID가 앱의 ID와 같고 Compose·Buildx 버전 조회가 성공해야 설치창으로 돌아간다. 취소·실패·중복 완료 요청을 성공으로 처리하지 않는다.

실패 뒤 자동 재시도하지 않는다. 다운로드 단계의 유효한 소유 marker, WSL 무등록, 디스크·가져오기 결과 없음, 고정 허용 파일만 존재하는 조건에서 새 승인으로 다운로드를 재시도한다. 가져오기 직전 단계를 영속 기록하고, 이후 실패나 단계가 불명확한 기존 부분 설치는 파일을 보존하고 차단한다. 삭제·초기화로 복구하지 않는다.

앱 제거는 WSL 배포판과 Docker 데이터를 삭제하지 않는다. 설치를 위해 기존 WSL을 먼저 삭제할 필요는 없다. 최초 엔진 설치는 온라인 방식이며 Docker Desktop의 VHDX·ISO를 재배포하지 않는다.

## 확인한 결과

| 검사 | 결과와 범위 |
| --- | --- |
| TypeScript·Vite | npm run build 종료 0. 재시도 UI 포함 |
| Rust | cargo check --bins --locked --offline 종료 0. 앱·Windows launcher 함께 검사, 실행하지 않음 |
| Rust 형식 | 변경한 launcher·platform·pipe·runtime 파일의 rustfmt --check 종료 0 |
| PowerShell·JSON | 설치·준비·빌드·포터블 스크립트 5개 parser 오류 0, 구성 JSON 2개 파싱 성공 |
| 구성 요소 준비 | 승인 후 다운로드·고정 해시 검사·배치 종료 0. 초기 캐시 부재·미고정 SHA-256 차단도 확인 |
| 포터블 | package-local.ps1 종료 0. 앱·launcher·공식 CLI·플러그인·가이드 포함, ZIP 크기와 SHA-256 일치 확인 |
| 엔진 없는 CLI | 새 빈 프로필에서 버전 조회 4개 종료 0: Docker 29.8.2, Compose 5.6.0, Buildx 0.38.0 |
| 기존 엔진 상태 | 승인 후 기존 소유 엔진 시작·검증·중지 복원 성공. 기존 컨테이너 2개·이미지 2개·볼륨 2개·네트워크 3개의 ID 보존 |
| 기존 디스크 | 검증 후 4,791,992,320 bytes. 엔진 실행으로 파일 크기·수정 시각은 변경됐으며, 디스크·WSL 등록·기존 리소스는 삭제하지 않음 |
| 설치 hook·PATH | Windows PowerShell 5.1의 임시 레지스트리 검증 8개 종료 0. 별도 Windows 환경에서도 같은 검증과 설치·제거 훅 컴파일 통과 |
| 로컬 설치판 제작 | NSIS File 입력 읽기 오류가 남음. 최신 훅도 user-path.ps1 입력에서 종료 1. 보안 설정은 변경하지 않음 |
| 원격 설치판 제작 | PATH 수정판 Windows 빌드 성공. 설치 EXE·SHA-256 산출물 생성, 공식 GitHub digest와 내부 EXE 해시 일치 확인. 가이드에서 수정 EXE 다운로드를 포함한 11개 검사 종료 0. [빌드 결과](https://github.com/seo-gali/dockslate/actions/runs/39767569820) |
| 실제 CLI | 명령 34개 중 32개 종료 0. 엔진 ID 일치·두 bind 양식의 공백/한글 경로·exec·표준 입력/EOF·Compose config/up/exec/down 확인 |
| 연결 종료 | 첫 연결의 출력 핸들 상속, exec 반종료, 취소 후 읽기 재시도 오류 수정. logs --follow 취소 후 배타적 엔진 lease 열기 성공 |
| 파일 복사 | Windows→컨테이너 읽기 접근 거부. 컨테이너→Windows는 첫 새 파일 생성 성공 후 같은 파일 덮어쓰기 접근 거부. 최신 전체 명령은 실패 종료 1로 기록 |
| 실제 설치·제거 | 기존 설치판은 사용자 PC의 긴 PATH로 중단됨. 수정판의 전체 설치·취소·제거와 깨끗한 PC의 엔진 설치는 미검증. 자동 실행하지 않음 |

최신 파일의 해시와 검사 범위는 [산출물 기록](installer-engine-integration.json), 긴 PATH 수정과 실제 엔진 조회는 [PATH 검증 기록](installer-path-e2e.json)에 남긴다. 이전 EXE의 네이티브 검사와 가이드 검사는 수정판 전체 설치의 동작 검증으로 간주하지 않는다.

## REA 근거와 남은 작업

[Docker Desktop 4.96.0 조사](../research/docker-desktop-4.96.0.md)에서 공식 설치 원본과 Windows CLI·plugins·backend의 실제 REA CLI Evidence를 확보했다. 배포 manifest·WSL 패키지 인벤토리는 일반 정적 추출 관찰과 구분했다. 이번 환경에는 REA MCP가 제공되지 않아 기존 REA CLI를 사용했으며 실행 관찰·IPC 추적은 하지 않았다. 이전 [Rancher 조사](../research/rancher-desktop-1.24.0.md)와 대상·근거를 혼동하지 않는다.

새 Windows 구성 요소 다운로드·포함은 사용자 계속 진행 지시로 승인받았다. 공식 배포본의 크기·해시를 검증하고 CLI ZIP의 SHA-256을 고정해 staging을 완료했다. 새 후보 실행은 사용자가 위험과 엔진 시작 영향을 확인하고 명시 승인했다. 빈 프로필의 버전 조회 4개와 실제 엔진·Compose 실행을 확인했으며, 검증용 컨테이너·네트워크만 삭제하고 엔진을 원래의 중지 상태로 복원했다. NSIS 입력 열기와 CLI 파일 복사 오류의 원인은 확정하지 않았다. 보안 설정·ACL·예외는 변경하지 않았다.
