# DockSlate

> REA로 Rancher Desktop을 분석해 구현하는 Windows용 경량 Docker 관리 앱

## 프로젝트

- **분석:** [REA (Reverse Engineer Anything)](https://github.com/morluto/rea) + Codex
- **분석 대상:** Windows용 Rancher Desktop(Electron, WSL2)
- **UI 참고:** [Dockhand](https://dockhand.pro/)의 정보 구성과 작업 흐름. 코드·에셋·화면은 복제하지 않음
- **플랫폼:** Windows 11
- **기술:** Tauri 2 · React · TypeScript · Rust · Docker Engine API
- **실행 방식:** 기존 Rancher Desktop의 Moby 엔진에 연결. 별도 엔진 설치·번들링 없음

Docker Desktop·Rancher Desktop 전체를 복제하지 않습니다. **자주 쓰는 Docker 작업과 Windows 디스크 공간 회수**에 집중합니다.

## MVP 범위

| 화면 | 기능 |
| --- | --- |
| Overview | 엔진 연결 상태, 실행 중 컨테이너 수, 이미지 수, 저장 공간 요약 |
| Containers | 목록·검색·상태, 시작·중지·재시작·삭제, 로그, Compose 프로젝트별 그룹 |
| Images | 목록·검색, Pull·삭제 |
| Disk Manager | Docker 사용량·정리 대상 분석, 미사용 이미지·빌드 캐시 선택 정리, WSL VHDX 탐색·크기 확인·조건부 압축 |
| Settings | Docker context/엔진 정보, 새로고침, 디스크 작업 전제 조건 안내 |

Compose 그룹은 Docker 메타데이터를 이용한 표시 기능입니다. Compose 파일 편집·배포, 터미널 Exec, Kubernetes, 원격 호스트, 계정 기능은 MVP에서 제외합니다.

## 디스크 관리 범위

1. Docker Engine에서 미사용 데이터와 사용량을 조회합니다.
2. 사용자가 선택한 **이미지·빌드 캐시만** 정리하며, 실행 중인 컨테이너·볼륨은 자동 삭제하지 않습니다.
3. WSL 배포판 등록 정보와 실제 파일 시스템에서 Rancher Desktop 및 Docker Desktop의 VHDX를 **각각 식별**합니다.
4. VHDX 압축 전 소유 런타임, 백업, 사용·마운트 상태, 실행 권한과 영향을 받는 WSL 세션을 확인합니다.
5. 안전 조건이 충족되고 사용자가 승인한 경우에만 Windows의 지원되는 압축 기능을 사용합니다. 조건을 확인할 수 없으면 실행을 차단합니다.
6. Docker의 정리 가능 추정치, VHDX 파일 크기, Windows에서 실제 회수한 용량을 **서로 다른 값**으로 표시합니다.

`docker_data.vhdx`와 같은 파일은 삭제할 찌꺼기가 아니라 Docker 데이터가 저장된 가상 디스크입니다. 원본 VHDX 직접 삭제와 경로 추측에 의한 조작은 금지합니다.

## REA 작업 방식

1. 설치된 Rancher Desktop의 버전과 실제 Electron 패키지(`app.asar` 또는 배포 디렉터리)를 식별합니다.
2. REA MCP로 모듈 구조, UI↔IPC, 컨테이너 제어, WSL 연동 지점을 조사합니다.
3. REA가 반환한 Evidence와 한계를 기록하고, [Rancher Desktop 공개 소스](https://github.com/rancher-sandbox/rancher-desktop)로 검증합니다.
4. 확인된 동작 중 MVP 기능만 독립적으로 구현합니다.
5. 원본과 DockSlate를 동일한 테스트 환경에서 실행해 결과를 비교합니다.

**REA 분석은 프로젝트의 필수 작업입니다.** 공개 소스만 읽거나 Docker API만 호출한 작업을 REA 역공학 성과로 표시하지 않습니다.

## 개발 시작

Windows 11에서 Node.js와 npm, Rust/Tauri 개발 환경, Rancher Desktop(Moby)을 준비합니다.

```powershell
npx rea-agents setup
npx -y rea-agents@latest doctor
npx -y rea-agents@latest analyze-javascript-application "<Rancher Desktop의 실제 app.asar 경로>" --json
```

REA 설정 시 Codex 연동을 선택합니다. 분석 대상 경로와 지원 기능은 로컬 환경에서 확인합니다. 앱 실행·빌드 명령은 **구현하고 실제로 검증한 후** 추가합니다.

## MVP 완료 기준

- REA 분석 대상·버전·Evidence·확인되지 않은 사항 기록
- 연결된 Moby 엔진에서 컨테이너·이미지 기능 E2E 통과
- Compose 그룹, 로그, 엔진 연결 실패 상태를 실제 데이터로 확인
- Docker 사용량과 Rancher/Docker VHDX의 소유자·경로·크기 구분
- 삭제 확인, 차단 조건, 압축 전제 조건 E2E 검증
- 안전한 테스트 디스크에서 압축 가능 여부 및 작업 전후 용량 검증; 불가한 환경은 미지원으로 명시
- Windows 앱 실행·빌드 검증 및 측정한 크기·메모리 사용량 기록

**상태:** 기획 문서. 현재 구현·검증 완료를 의미하지 않습니다.

## 근거 및 참고

- [REA](https://github.com/morluto/rea)
- [Rancher Desktop 아키텍처](https://docs.rancherdesktop.io/references/architecture/)
- [Rancher Desktop 소스 및 Apache-2.0](https://github.com/rancher-sandbox/rancher-desktop)
- [Dockhand](https://github.com/Finsys/dockhand) · [Dockhand 라이선스(BSL 1.1)](https://dockhand.pro/license.html)
- [Docker Engine API](https://docs.docker.com/reference/api/engine/) · [Docker 데이터 정리](https://docs.docker.com/engine/manage-resources/pruning/)
- [Microsoft WSL 디스크 관리](https://learn.microsoft.com/windows/wsl/disk-space)
