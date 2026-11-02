# DockSlate 제품 범위

현재 구현 기준은 0.1.6이다. 초기 MVP 제외 목록이나 과거 호스트 설치 경로를 현재 기능·작업 승인으로 사용하지 않는다. 실행 방법은 [README](../README.md), 동작은 [사용 안내](../USER_GUIDE.md), 검증 범위는 [요청 현황](../docs/REQUEST_STATUS.md)이 기준이다.

## 구성과 화면

Windows 11 x64용 Tauri 2·React·TypeScript·Rust 앱이다. 전용 WSL 2 배포판 `DockSlate`에 Moby 기반 Docker Engine을 설치한다. Windows Docker CLI·Compose·Buildx는 사용자 전용 pipe로 소유 엔진에 연결한다. Docker Desktop·Rancher Desktop의 데이터는 자동 이관하지 않는다.

| 메뉴 | 지원 기능 |
| --- | --- |
| 개요 | 연결·엔진 버전·API·실행 커널·컨테이너·이미지·사용량 |
| 컨테이너 | 검색·필터·정렬, Compose 그룹 접기, 시작·중지·재시작·삭제 승인, 수정, 상세·로그·JSON·마운트·터미널·파일 |
| 이미지 | 로컬 목록·참조·실행 설정·명령 미리보기, Docker Hub 검색·Pull, 삭제 승인 |
| 리소스 | 볼륨·네트워크·참조, 볼륨 파일·tar 전송, 생성·조건부 삭제 |
| 빌드 | Dockerfile·Compose 선택 후 자동 빌드, 별도 Compose 실행 승인, 진행·기록·빌더 관리·기록 가져오기/내보내기 |
| 디스크 관리 | Docker 사용량·정리 후보·승인, WSL VHDX 탐색·안전 조건 확인·조건부 공간 회수 |
| 설정 | 한국어/영어·다크/라이트·11~16px 글자, 런타임 설치·시작·중지, 엔진 연결 정보 |

이미지 받기 → 실행 설정 확인 → 컨테이너 생성 → 상태·로그 확인이 기본 흐름이다. 프로젝트는 빌드 메뉴에서 파일을 선택한다. Dockerfile은 이미지 생성까지 진행하고 컨테이너는 로컬 이미지에서 실행한다. Compose는 빌드 후 서비스·포트·새 리소스와 영향을 확인해 별도로 실행을 승인한다.

## 지원 경계와 데이터

- Compose는 제한된 로컬 프로젝트 가져오기다. YAML 편집기·기존 프로젝트 교체·Kubernetes 배포·무제한 옵션은 제공하지 않는다. 치환·비밀 파일·외부 컨텍스트·bind·privileged·장치 연결은 차단한다.
- 기존 컨테이너의 이름은 직접 변경한다. 포트·볼륨·네트워크 변경은 지원 조건을 검사하고 파일 보존 이미지·승인을 거쳐 재생성한다. Compose·Swarm·고정 IP 등은 이름 변경만 지원한다.
- 삭제·Prune·WSL 공간 회수는 대상·참조·소유권·영향을 검사해 별도 승인한다. 조회 시 선택 가능 상태가 실행 성공을 보장하지 않는다. 볼륨 자동 삭제·VHDX 직접 삭제·무조건적인 WSL 전체 종료는 금지한다.
- 런타임 위치는 실제 설정·소유권·등록 경로를 확인한다. 과거 개인 경로를 기본값이나 복구 승인으로 사용하지 않는다. 앱·엔진·WSL 커널 업데이트는 별개다.
- Docker 정리 추정치·VHDX 크기·Windows 회수량은 구분한다. 압축은 안전 조건 미확인 시 차단하며 크기 감소를 보장하지 않는다.

## 조사와 검증

외부 앱의 배포 동작을 조사할 때는 [외부 앱 조사 기준](../docs/CODING_STANDARDS.md#외부-앱-조사)을 따른다. 기존 [Rancher Desktop 조사](../docs/research/rancher-desktop-1.24.0.md)와 [Docker Desktop 조사](../docs/research/docker-desktop-4.96.0.md)의 원본·근거를 보존한다. 일반 소스·문서 수정 때문에 외부 앱 조사를 반복하지 않는다.

현재 앱의 [빌드·공개 산출물](../docs/results/release-0.1.6.md), 이 PC의 [빈 엔진 재설치](../docs/results/reinstall-recovery.md), [배포 점검](../docs/results/production-readiness.md)은 서로 다른 범위다. 과거 통과 기록을 최신 전체 회귀로 간주하지 않는다. 미서명·접근 경고 원인·제거·데이터 복구·전체 회귀의 미완료는 각 기록에 유지한다.

[작업 지침](../AGENTS.md) · [개발·빌드](../docs/DEVELOPMENT.md) · [UI 기준](../docs/DESIGN.md)
