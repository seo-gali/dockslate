# DockSlate — MVP 기획서

> REA 기반 Rancher Desktop 역공학을 통해 자주 사용하는 Docker 관리 기능을 재구현하고, Windows WSL 디스크 관리 기능을 제공하는 경량 데스크톱 앱

## 1. 프로젝트 정의

| 항목 | 결정 |
| --- | --- |
| 프로젝트·저장소·디렉터리 | `dockslate` |
| 핵심 목적 | **REA(Reverse Engineer Anything)를 활용한 실제 애플리케이션 역공학과 기능 재구현** |
| 분석 대상 | Windows용 Rancher Desktop 배포본 |
| UI 참고 대상 | Dockhand의 작업 중심 정보 구성. 코드·에셋·화면 직접 복제 금지 |
| 대상 사용자 | Windows 11에서 로컬 Docker를 사용하는 개발자 |
| 구현 기술 | Tauri 2, React, TypeScript, Rust, Docker Engine API |
| 실행 전제 | DockSlate 전용 WSL 2 배포판의 **Moby(dockerd) 엔진** 실행 |
| 개발 범위 | Phase 분리 없는 단일 MVP |

DockSlate의 목표는 **Docker Desktop을 제거한 뒤 독립적인 Linux 컨테이너 엔진과 관리 화면을 제공하는 것**입니다. 전용 WSL 2 배포판에 Moby 엔진을 설치하고 시작·중지를 관리합니다. 기존 Docker Desktop/Rancher Desktop 저장소는 재사용하거나 자동 이관하지 않습니다. REA 관찰은 보존하며 독립 런타임의 공개 소스 근거와 독자 설계를 구분합니다.

## 2. 해결할 문제

- 로컬 개발자가 컨테이너 시작·중지, 로그 확인, 이미지 정리를 위해 복잡한 관리 화면을 탐색해야 하는 불편
- Docker 이미지·빌드 캐시 삭제 후에도 WSL VHDX가 차지하는 Windows 저장 공간이 바로 줄어들지 않을 수 있는 문제
- Docker 데이터 정리량과 실제 Windows 디스크 공간 회수량을 구분하기 어려운 문제
- 역공학 결과를 실사용 가능한 소프트웨어로 재구현하고 검증할 수 있는 프로젝트의 필요

## 3. 사용자 작업 흐름

1. 앱 실행 → Settings에서 독립 런타임의 설치 대상 확인·승인 → 전용 엔진 시작·Moby API 확인
2. **Overview**에서 컨테이너·이미지·저장 공간 현황 조회
3. **Containers**에서 대상 검색 → 시작·중지·재시작·삭제 또는 로그 확인
4. **Images**에서 이미지 확인 → Pull, 로컬 Dockerfile 빌드 또는 사용하지 않는 이미지 삭제
5. **Disk Manager**에서 Docker 사용량과 WSL VHDX 파일 크기 구분 확인
6. 미사용 이미지·빌드 캐시 정리 또는 안전 조건이 충족된 VHDX의 압축 실행 → 작업 전후 결과 검증

엔진 미설치·중지·연결 실패, containerd 사용, 권한 부족, 압축 불가 환경을 구분합니다. 조회는 중지된 배포판을 시작하지 않습니다. 설치와 시작·중지는 명시적으로 승인한 DockSlate 배포판에만 적용합니다.

## 4. MVP 기능 범위

| 화면 | 필수 기능 | 범위 제한 |
| --- | --- | --- |
| **Overview** | Docker 연결 상태, 실행·중지 컨테이너 수, 이미지 수, 저장 공간 요약 | 실측값만 표시 |
| **Containers** | 목록·검색·상태, 시작·중지·재시작·삭제, 로그 스트리밍·검색, Compose 프로젝트별 그룹 | Compose 라벨 기반 그룹 표시까지만 |
| **Images** | 이미지 목록·검색, Pull, 로컬 Dockerfile 빌드, 삭제 | 빌드 경로·태그 검증, 사용 중인 이미지 삭제 방지 및 실패 이유 표시 |
| **Disk Manager / Docker Usage** | 이미지·컨테이너·볼륨·빌드 캐시 사용량 조회, 미사용 이미지·빌드 캐시 선택 정리 | 컨테이너·볼륨 자동 정리 금지 |
| **Disk Manager / WSL Disks** | DockSlate/Rancher Desktop/Docker Desktop VHDX 탐색, 소유자·경로·파일 크기 표시, 조건부 압축 | 소유·사용 상태가 검증되지 않으면 압축 차단 |
| **Settings** | 독립 엔진 설치·시작·중지, 엔진 정보·새로고침, 환경 및 권한 안내 | 고정된 전용 배포판과 검증된 공식 설치 입력만 사용 |

### 디스크 관리 원칙

- **Docker 정리**는 Docker Engine API가 관리하는 객체에만 적용합니다. 삭제 후보와 영향을 표시하고, 실행 직전 객체 참조 상태를 다시 검증합니다.
- **WSL 디스크 관리**는 Windows 파일 시스템과 WSL 등록 정보를 기준으로 실제 VHDX를 식별합니다. Rancher Desktop과 Docker Desktop 저장소를 혼동하지 않습니다.
- VHDX 압축은 지원되는 Windows 방식으로 수행하며, **소유 런타임 중지, 디스크 분리·잠금 상태, 권한, 영향받는 WSL 배포판**을 검사합니다. 2026-10-16 사용자의 명시적 변경 지시에 따라 백업을 생성·요구하지 않으며, 원본 디스크 변경과 복구 제한을 최종 승인창에 표시합니다.
- 압축 전제 조건을 객관적으로 확인할 수 없으면 작업을 허용하지 않습니다. 다른 WSL 배포판까지 종료할 필요가 있을 때는 영향을 알리고 별도 승인을 받습니다.
- VHDX 파일 직접 삭제·초기화, 무조건적인 `wsl --shutdown`, 볼륨 자동 삭제, 일괄 `docker system prune` 실행은 금지합니다.
- 표시할 수치는 `Docker 정리 가능 추정치`, `VHDX 파일 크기`, `Windows 실제 회수량`으로 구분합니다. 회수량은 작업 **전 파일 크기 − 작업 후 파일 크기**로 계산하며, 음수라면 0으로 덮어쓰지 않고 실제 변화를 표시합니다.
- 압축 미지원 환경에서도 VHDX 식별과 사용량 조회 기능은 유지합니다. 실제 압축을 검증하지 못한 환경을 지원 완료로 표기하지 않습니다.

## 5. REA 분석 요구사항

REA는 프로젝트의 핵심 구현 과정입니다. 분석 보고서 작성만으로 완료하지 않습니다.

1. 설치된 Rancher Desktop의 **버전, 실제 배포 경로, 분석 대상 파일** 확인
2. REA MCP로 Electron 모듈, renderer ↔ preload/main IPC, Docker/WSL 제어 경로 분석
3. 컨테이너·이미지·로그·WSL 저장소 기능에서 **분석 Evidence와 호출 관계** 확보
4. Rancher Desktop 공개 소스코드와 대조하여 확인된 사실·불일치·미확인 사항 기록
5. 분석된 동작 중 MVP 기능만 자체 코드로 재구현하고 원본과 실행 결과 비교

검증 기록은 `docs/results/rea-analysis.md`에 남깁니다. **REA 결과 / 공개 소스 검증 / 독자 설계**의 근거를 구별합니다. REA가 분석을 지원하지 않는 영역은 미확인으로 기록하며 추측으로 채우지 않습니다. 원본 설치 파일을 수정하거나 외부 프로젝트 코드를 그대로 이식하지 않습니다.

## 6. 화면 및 사용성

- 화면 구성: **Overview / Containers / Images / Disk Manager / Settings**
- 다크 모드 기본, 고정 사이드바, 검색 가능한 데이터 테이블, 상세·로그 패널
- 선택한 대상의 상태와 실행 가능한 동작이 바로 보이는 작업 중심 UI
- 로딩·빈 상태·연결 실패·권한 부족·처리 중·성공·실패를 명확하게 구분
- 파괴적 작업은 대상과 영향 범위를 보여주는 확인 대화상자 사용
- 디자인 토큰, 컴포넌트, 창 크기 및 접근성 세부 기준은 `docs/DESIGN.md`에서 관리

## 7. MVP 제외 범위

- 기존 Docker Desktop 데이터 자동 이관·제거, 엔진 자동 업데이트, Kubernetes 등 전체 데스크톱 기능 복제
- Kubernetes, containerd 네이티브 제어, 원격 Docker 호스트, 다중 사용자·로그인
- Compose YAML 편집·배포, 컨테이너 터미널 Exec, 파일 브라우저, Extensions
- 볼륨 삭제, 네트워크 정리, 예약 정리, 자동 디스크 압축, 백업·복구 시스템 구축
- 원본 Rancher Desktop·Dockhand UI 또는 브랜드의 직접 복제

## 8. 완료 판정

| 검증 영역 | 완료 기준 |
| --- | --- |
| **REA** | 실제 Rancher Desktop 배포본에서 REA 분석 수행, 버전·Evidence·호출 관계와 미확인 사항 기록 |
| **Engine** | Docker Desktop/Rancher Desktop에 의존하지 않는 전용 엔진 설치·시작·API 연결·중지·재시작 E2E, 미설치·실패 상태 표시 |
| **Containers** | 실제 테스트 컨테이너의 시작·중지·재시작·삭제와 로그 확인 E2E 통과 |
| **Images** | 테스트 이미지 Pull·조회·삭제 및 참조 중 이미지 삭제 차단 검증 |
| **Disk Usage** | 사용량 조회, 미사용 이미지·빌드 캐시 정리, 선택 대상·실행 전후 결과 검증 |
| **WSL Disks** | 실제 파일의 소유 런타임·경로·크기 확인, 압축 차단 조건 검증 |
| **VHDX 압축** | 안전한 격리 테스트 디스크에서 전제 조건·압축·전후 크기 측정 E2E 통과. 미검증 환경에서는 차단·미지원 표시 |
| **UI** | 모든 메뉴가 실데이터로 동작하고, 빈 상태·오류·확인 대화상자 검증 |
| **배포** | Windows 11에서 앱 실행·패키징·재실행 검증, 앱 설치 크기와 메모리 사용량 실측 기록 |

테스트는 실제 사용자 경로의 E2E를 우선합니다. 삭제·디스크 압축 테스트는 격리된 테스트 데이터로 진행하고, 실패 조건을 먼저 정의합니다. **실행하지 않은 테스트나 측정하지 않은 수치를 완료로 기록하지 않습니다.**

## 9. 문서 역할

- `.project/plan.md`: 프로젝트 목표·MVP 범위·완료 기준
- `AGENTS.md`: Codex/REA 작업 규칙과 안전 제약
- `docs/DESIGN.md`: UI 정보 구조와 디자인 기준
- `README.md`: 구현 상태 및 사용자 실행 방법(검증 후 갱신)
- `docs/results/rea-analysis.md`: 실제 분석 Evidence 및 재구현 검증 결과(작업 중 생성)

## 10. 근거 자료

- [REA — 공식 저장소 및 MCP 사용법](https://github.com/morluto/rea)
- [Rancher Desktop — 공식 소스코드·Apache-2.0](https://github.com/rancher-sandbox/rancher-desktop)
- [Rancher Desktop — Architecture](https://docs.rancherdesktop.io/references/architecture/)
- [Docker — Prune unused Docker objects](https://docs.docker.com/engine/manage-resources/pruning/)
- [Microsoft — WSL disk space](https://learn.microsoft.com/en-us/windows/wsl/disk-space)
- [Microsoft — compact vdisk](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact-vdisk)
- [Dockhand — 기능 및 라이선스](https://github.com/Finsys/dockhand)

**상태: 독립 런타임 MVP 구현·검증 중. 사용자는 전용 WSL 엔진 설치와 Docker Desktop 제거·소유 VHDX 삭제를 승인했으며 새 설치 위치는 `D:\Program Files\DockSlate\runtime\wsl`입니다. 이전 클라이언트 EXE 검증과 독립 엔진 실행 검증을 구분합니다.**

2026-10-16 현재 독립 엔진 설치·연결과 Docker Desktop 공식 제거 후 기능 검증을 완료했습니다. 앱 시작 시 모든 메뉴 데이터를 준비하며 메뉴·탭 이동 중 추가 조회는 0회로 확인했습니다. 일반 데이터 갱신은 수동 새로고침으로 수행합니다. 실제 WSL VHDX 압축 성공은 검증하지 않았고 안전 조건 미충족 시 차단합니다. 최신 실행 파일과 검사별 결과는 `docs/results/standalone-runtime-verification.md`에 기록합니다.

2026-10-17 로컬 Dockerfile 이미지 빌드와 진행 로그를 추가했습니다. 실제 전용 엔진에서 실패·수정 후 재시도·COPY 파일·.dockerignore·자동 갱신·기존 데이터 보존 E2E 6개를 통과했습니다. 네이티브 폴더 선택 확정은 검증 도구 오류로 미검증이며 경로 직접 입력의 빌드는 검증했습니다.
