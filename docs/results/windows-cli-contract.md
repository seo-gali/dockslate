# Windows Docker CLI

새 구성은 공식 Windows Docker CLI 29.8.2·Compose 5.6.0·Buildx 0.38.0을 DockSlate 소유 Linux 엔진에 연결한다. 기존 WSL 명령별 인수 변환 런처를 교체했다. 다운로드·설치 및 실제 명령 검증이 끝나기 전까지 배포 완료로 간주하지 않는다. [설치 검증](installation-correction.md), [Docker Desktop 정적 조사](../research/docker-desktop-4.96.0.md).

## 실행과 프로필

- `bin/docker.exe`는 같은 설치의 `libexec/docker.exe`를 실행한다. stdin·stdout·stderr와 종료 코드를 그대로 전달하며 셸 문자열을 만들지 않는다. 준비 실패는 종료 125다.
- Compose와 Buildx는 공식 Windows 플러그인이다. 파일·환경 변수·빌드 context는 Windows에서 해석한다. 원본 Compose YAML과 Dockerfile을 재작성하지 않는다.
- 프로필은 `%LOCALAPPDATA%\DockSlate\cli`다. 기존 `%USERPROFILE%\.docker`나 다른 제품의 설정·인증 정보를 읽거나 복사하지 않는다. launcher와 installer는 `config.json`을 만들거나 수정하지 않는다. 공식 CLI 자체의 로그인·설정 명령은 이 전용 프로필을 사용한다.
- 플러그인은 완성된 임시 파일을 교체 없는 Windows rename으로 게시한다. 같은 파일이 이미 있으면 재사용하고, 다른 파일이 있으면 보존하고 충돌로 중단한다. 프로필 경로의 reparse point를 거부하고 디렉터리 핸들을 유지한다. 이전 버전 플러그인의 자동 교체는 구현하지 않았다.
- 기본 endpoint는 `npipe:////./pipe/dockslate_engine_<현재 사용자 SID>`다. inherited context·TLS·Buildx 선택 변수는 제거한다. 사용자가 명시한 CLI host·context 옵션은 공식 CLI가 처리한다. 직접 CLI 사용에는 Docker daemon 권한이 있으며 앱의 승인 팝업을 거치지 않는다.
- 도움말·클라이언트 버전·플러그인 버전은 엔진 중지 상태에서도 실행할 수 있어야 한다. CLI가 엔진을 자동 설치·시작하지 않는다.

## 엔진 연결

같은 설치의 `dockslate.exe --engine-proxy`가 GUI와 별도로 실행된다. pipe는 현재 사용자만 접근하며 다른 프로세스가 같은 이름을 점유하면 소유자와 실행 경로를 확인한다. 서버는 활성 요청에만 기존 엔진 소유권 lease를 유지하고, 검증된 WSL Unix socket의 `docker system dial-stdio`로 연결한다. 엔진 소유권·종류·ID 검증을 생략하지 않는다.

broker를 시작할 때 호출자의 핸들을 상속하지 않는다. 실제 첫 연결에서 Docker 버전 출력과 종료 코드 0 이후에도 stdout EOF가 오지 않아 60초 timeout이 발생했다. 새 broker가 CLI의 출력 파이프를 계속 보유하면 안 되며, 프로세스 종료뿐 아니라 출력 스트림 종료까지 검증한다.

pipe는 message type·byte read mode로 만들어 Windows 클라이언트의 zero-byte message 입력 종료를 지원한다. 입력 종료 후 출력은 끝까지 전달하고, 실제 클라이언트 연결 종료를 확인해 guest relay와 lease를 회수한다. 이 경계가 없으면 `exec`가 내용을 출력한 뒤에도 종료하지 않는다. 근거는 Microsoft [go-winio CloseWrite 구현](https://github.com/microsoft/go-winio/blob/v0.6.2/pipe.go#L137-L184)과 Docker [입출력 스트림 처리](https://github.com/docker/cli/blob/v29.8.2/cli/command/container/hijack.go#L156-L186)이며 DockSlate의 실제 컨테이너로 재검증한다.

취소는 재시도 가능한 `Interrupted` 대신 연결 종료 오류로 전달한다. 동기 guest 읽기를 취소한 뒤에도 다음 읽기에서 취소 상태를 확인한다. `io::copy`의 자동 재시도가 worker와 엔진 lease를 계속 잡지 않아야 하며, 실제 `logs --follow` 클라이언트 종료 후 배타적 lease 열기로 확인한다.

broker는 CLI 요청 시 준비되며 연결 없이 90초가 지나면 종료한다. 다음 CLI 요청은 다시 준비하지만 SDK 단독 접속을 상시 보장하지 않는다. 연결 사이의 HTTP 유휴 제한은 30초, guest relay 수명 상한은 24시간이다. 장기 로그·attach 같은 외부 CLI 연결은 엔진 변경 lease를 유지하므로 해당 명령을 먼저 종료해야 런타임을 중지할 수 있다. GUI에서 다른 프로세스의 활성 CLI 스트림을 취소하는 기능은 제공하지 않는다.

다른 Windows Docker SDK는 위 endpoint를 명시해야 한다. 전역 `docker_engine` pipe를 점유하거나 시스템의 Docker context·환경 변수를 덮어쓰지 않는다. GUI 내부 Docker API 조회는 기존 제한된 WSL transport를 유지한다.

컨테이너 생성 JSON의 `HostConfig.Binds`와 `HostConfig.Mounts` 중 bind source의 Windows 절대경로만 실제 WSL 경로로 변환한다. named volume·guest 절대경로·컨테이너 target·환경 변수는 보존한다. UNC·drive-relative 경로 등 지원하지 않는 입력은 거부한다. volume driver의 Windows 경로 옵션·Swarm mount 변환은 제공하지 않는다. 로그·이벤트·빌드 tar·대화형 스트림을 전체 메모리에 수집하지 않는다.

## 빌드와 검증

`scripts/prepare-windows-docker.ps1`는 기본적으로 기존 캐시를 검증하고 배치한다. 새 다운로드는 사용자 승인 뒤 `-AllowDownload`로만 수행한다. Docker CLI ZIP의 독립 SHA-256 공개값은 확인하지 못했으므로 최초 다운로드의 계산값을 고정하기 전에는 제품 staging을 차단한다. 플러그인은 공식 공개 SHA-256과 비교한다. Docker Desktop에서 추출한 바이너리는 분석에만 사용한다.

`scripts/build-cli.ps1`은 기존 Rust MSVC 도구와 잠긴 의존성으로 Windows launcher를 빌드한다. 설치판·포터블에는 공식 Windows CLI·플러그인·라이선스를 함께 포함해야 하며 launcher만 복사해서는 동작하지 않는다.

컴파일과 PowerShell parser 검사는 실제 연결 검증을 대신하지 않는다. 새 터미널 PATH, 같은 engine ID, Compose 구성·빌드·실행, bind 양식 두 가지, build/load/save/cp, exec/attach·취소, foreign pipe 거절, GUI 종료 후 CLI는 새 후보에서 별도 확인한다. 기존 MongoDB와 볼륨을 변경하지 않는다.

실제 검증에서 두 bind 양식과 `exec` 종료는 통과했지만 공식 Windows CLI의 `cp`가 검증용 로컬 파일을 읽을 때 `Access is denied`로 실패했다. 원인은 확정하지 않았다. 보안 설정·ACL을 바꾸거나 다른 프로그램으로 파일을 대신 읽지 않는다. 독립된 입출력·로그 취소·Compose 검사를 계속 수행하되, 실패한 항목은 전체 결과에 남기고 검증 명령은 실패로 종료한다. 새 검증 컨테이너·네트워크만 정리하고 기존 리소스 ID와 엔진의 원래 중지 상태를 확인한다.

최신 후보의 실제 명령 34개 중 32개가 성공했다. bind·표준 입력/EOF·로그 취소 후 lease 해제·Compose config/up/exec/down은 통과했고, 파일 업로드와 기존 Windows 파일 덮어쓰기는 접근 거부로 실패했다. 명령 전체 종료는 1이다. 기존 리소스 ID 보존과 엔진 중지 복원을 확인했으며 새 설치·Dockerfile 빌드·설치 PATH 검증을 대신하지 않는다. [실제 출력](native-cli-connection.json), [복원·빌드 기록](installer-engine-integration.json).
