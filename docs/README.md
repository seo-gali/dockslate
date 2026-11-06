# 문서 안내

현재 개발·공개 버전은 0.1.9다. 사용 방법·개발 계약과 과거 실행 결과를 구분한다. 검증 문서의 날짜·버전·EXE 해시는 해당 실행의 기준이며, 문서를 고쳤다고 앱을 다시 검증한 것은 아니다.

## 현재 안내와 개발 기준

| 문서 | 용도 |
| --- | --- |
| [프로젝트 소개](../README.md) · [사용 안내](USER_GUIDE.md) | 다운로드·설치·현재 메뉴·작업 순서 |
| [제품 범위](../.project/plan.md) | 지원 기능·미지원 범위 |
| [개발·빌드](DEVELOPMENT.md) · [Pages](PAGES.md) | 소스 구성·빌드·정적 사이트 생성 |
| [코딩 기준](CODING_STANDARDS.md) · [UI 기준](DESIGN.md) | 구현·조회·데이터·화면 규칙 |
| [Node.js 예제](../examples/basic-web/README.md) | 앱에서 선택할 Dockerfile·Compose와 소스 |
| [Windows CLI 계약](results/windows-cli-contract.md) | 현재 launcher·프로필·엔진 연결과 검증 경계 |
| [독립 엔진 검사 절차](results/independent-engine-e2e-procedure.md) | 검증 스크립트의 실제 변경 범위·승인 조건 |
| [작업 지침](../AGENTS.md) | 실행·승인·데이터 보존 경계 |

## 현재 배포와 검증 상태

| 문서 | 읽는 범위 |
| --- | --- |
| [요청·검증 현황](REQUEST_STATUS.md) · [배포 전 점검](results/production-readiness.md) | 구현·실행 확인·미검증의 현재 요약 |
| [0.1.9 공개 배포](results/public-distribution-0.1.9.md) · [제작·검사](results/release-0.1.9.md) | Release 첨부 4개·체크섬·VirusTotal, 자동 시작·일괄 작업·제거 알림 대기 변경과 미검증 범위 |
| [0.1.7 릴리스](results/release-0.1.7.md) · [이벤트 자동 갱신](results/engine-events.md) | 실제 앱 24개·CLI 4개·패키지 검증, DockSlate WSL 재시작·기존 SQL 실행 상태 복원 |
| [0.1.6 제작 기록](results/release-0.1.6.md) · [고정 공개 검사](results/public-release-0.1.6.json) | 2026-10-31 빌드·패키지·공개 파일 검사 |
| [실제 재설치](results/reinstall-recovery.md) | 2026-11-02 이 PC의 빈 엔진 재설치·앱·CLI 확인 |
| [가이드 촬영](results/guide-video.json) | 0.1.6 예제 빌드·실행·영상 검사. 로컬 media는 Git 제외 |
| [서명·보안 상태](results/code-signing.md) | 미서명과 과거 접근 경고의 조사 한계 |
| [WSL 커널 기록](results/cve-2026-98432-wsl.md) | 해당 PC·시점의 커널 적용. 앱 설치 파일이나 다른 장비의 패치 보증으로 사용하지 않음 |
| [문서·로컬 정리 검사](results/documentation-maintenance.json) | 검사한 문서·링크·내용 수정과 임시 파일 삭제 범위 |

## 과거 조사·검증 기록

| 기록 | 고정된 대상·시점 |
| --- | --- |
| [Rancher Desktop](research/rancher-desktop-1.24.0.md) · [Docker Desktop](research/docker-desktop-4.96.0.md) | 특정 외부 버전의 정적 조사. 현재 DockSlate 의존성·연결 대상 안내와 구분 |
| [초기 MVP](results/mvp-verification.md) · [백엔드 근거](results/docker-backend-evidence.md) · [구현 근거](results/rea-analysis.md) | Rancher 연결 클라이언트 시절의 설계·차단 검사. 현재 앱은 전용 엔진 사용 |
| [런타임 입력](results/standalone-runtime-evidence.md) · [런타임 실행 이력](results/standalone-runtime-verification.md) | 2026-10-14 이후 독립 엔진 전환. 옛 설치 경로·백업 조건·새로고침 위치는 현재 절차가 아님 |
| [작업 기능](results/workbench-verification.md) · [화면 개선](results/refinement-verification.md) · [실제 조작](results/interaction-workflows.md) | 2026-10-17~18 후보별 실행. 당시 미검증 표시를 현재 미지원으로 해석하지 않음 |
| [API·성능](results/api-performance.md) · [표](results/table-layout.md) · [Inspect](results/inspect-lifecycle.md) | 각각 보존된 후보 해시·측정값·입력 범위 |
| [접근 경고](results/browsing-data-alert.md) · [파서 탐지](results/build-records-av-incident.md) | 경고·접근 관측 원본. 무해 판정·현재 버전 전체 보안 검사로 사용하지 않음 |
| [제거 사전 조사](results/desktop-removal-preflight.md) · [로컬 전달](results/local-delivery.md) · [설치 수정](results/installation-correction.md) | 예전 설치·프로세스·경로·파일 정보. 새 제거·초기화 승인으로 사용할 수 없음 |
| [압축 복구](results/wsl-compaction-recovery.md) · [정리 UI](results/cleanup-feedback.md) | 2026-10-27·31의 실제 대상·후보별 검사 |
| [0.1.1](results/release-0.1.1.md) · [0.1.2](results/release-0.1.2.md) · [0.1.3](results/release-0.1.3.md) · [0.1.4](results/release-0.1.4.md) · [0.1.5](results/release-0.1.5.md) | 각 릴리스의 제작·다운로드 이력 |
| [REA 호출 감사](results/rea-mcp-call-audit.md) · [지침 검토](results/agents-instructions-review.md) · [A/B 실험](results/agents-ab.md) · [이전 정리](results/maintenance-review.md) | 기록에 명시된 세션·커밋·시점 |

`installer-engine-integration.json`·`delivery-artifacts.json` 같은 공용 산출물 명세는 후속 빌드로 갱신된다. 과거 버전의 불변 증거가 필요하면 `public-release-0.1.x.json` 등 버전이 고정된 기록과 본문의 대상 해시를 사용한다. 원시 JSON·보안 추적·라이선스 원문은 설명을 최신화한다는 이유로 덮어쓰지 않는다.

[IObit 제출 초안](results/iobit-access-review-draft.md)은 미전송 문서이며 제출 승인이나 원래 경고의 원인 확정이 아니다. [라이선스 자료](../licenses/README.md)는 원문·소스·고지 목록을 관리한다.

[현재 고지](../licenses/THIRD_PARTY_NOTICES.md)는 0.1.9이며 사이트 빌드 시 다운로드 경로에 복사한다. [예전 docs 경로의 고지](downloads/THIRD_PARTY_NOTICES.md)는 0.1.5 호환 스냅샷으로 보존하며 현재 버전 안내로 사용하지 않는다.
