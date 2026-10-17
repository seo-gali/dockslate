# 독립 엔진 E2E 실행 조건

실행 대상은 디버깅 포트를 연 실제 Windows DockSlate 실행 파일과 이미 설치·시작한 전용 `DockSlate` 배포판이다. 이 문서는 실행 성공을 의미하지 않는다. 실제 결과는 실행 시 `independent-engine-e2e.json`에 기록된다.

```powershell
node scripts/verify-independent-engine.mjs PATH_TO_DEVTOOLS_ACTIVE_PORT --approved-isolated-fixtures
```

실패 조건은 소유권·등록 ID 변경, Linux Moby 연결 검증 실패, 기존 컨테이너·이미지가 있는 초기 상태, 실제 엔진 상태와 UI·API 결과의 불일치, 승인 없이 삭제 허용, 예상하지 않은 삭제 대상, 삭제 실패 또는 타임아웃이다. 하나라도 발생하면 중단하며 남은 테스트 데이터를 자동 삭제하지 않는다. 실행 시간 제한은 작업이 취소되었다는 뜻이 아니다.

스크립트는 호스트 Docker CLI·현재 context를 사용하지 않는다. 앱의 소유권 검증 후 Windows 시스템 `wsl.exe --distribution DockSlate --user root --exec /usr/bin/docker --host unix:///var/run/docker.sock`만 사용하며, CLI 작업은 독립 엔진 정보 확인·정확한 테스트 이미지/컨테이너 조회·`dockslate-e2e-*` 컨테이너 생성으로 제한된다. Pull, 시작·중지·재시작, 로그, 삭제, 선택 이미지 정리, 런타임 중지·시작은 앱의 실제 UI 또는 Tauri IPC를 사용한다.

테스트 이미지는 Docker 공식 이미지 등록에서 확인한 [`busybox:1.37.0`](https://raw.githubusercontent.com/docker-library/official-images/master/library/busybox)이다. 태그는 불변 digest가 아니며, 다운로드한 실제 ID와 RepoDigests를 결과에 기록한다. 테스트는 빈 엔진에서만 시작하고 만든 컨테이너와 정확한 이미지 ID만 삭제한다.

출력 폴더 내 고유한 테스트 텍스트 파일만 `/mnt/<drive>/...`로 읽기 전용 bind mount하며, 별도 BusyBox HTTP 컨테이너의 `127.0.0.1::8080` 게시에서 엔진이 할당한 실제 포트를 조회한다. Windows의 해당 localhost URL에 접속해 정확한 테스트 파일 본문을 확인한다. 실패 시 전역 설정을 변경하거나 다른 포트로 재시도하지 않는다. 작은 테스트 파일은 증거로 보존한다. 설치한 Buildx·Compose CLI 버전도 전용 배포판에서 조회한다.

빌드 캐시 삭제, VHDX 압축·삭제 및 Docker Desktop 데이터 이전은 이 스크립트의 검증 범위 밖이다. 기존 배포판의 종료·삭제, 전역 Prune, 강제 삭제 또는 WSL 전체 종료 명령은 실행하지 않는다.

준비 검증: `node --check scripts/verify-independent-engine.mjs` 통과. 승인 인수가 없는 실행은 로컬 디버깅·WSL·Docker 접근 전에 종료한다. 실제 독립 엔진 E2E는 이 기록 작성 시 실행하지 않았다.
