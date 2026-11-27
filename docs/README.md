# 문서 안내

현재 공개 배포본은 **0.1.15 미서명 개발판**이다. 자동 시작·가져오기 분할·선택 삭제 수정을 포함한다. 포터블 ZIP의 DeepInstinct 탐지 1건을 고지하고 승인받아 공개했으며 오탐 여부는 미확인이다. 과거 검사 기록은 해당 버전·파일 해시를 유지한다.

## 현재 안내와 개발 기준

| 문서 | 용도 |
| --- | --- |
| [프로젝트 소개](../README.md) · [사용 안내](USER_GUIDE.md) | 다운로드·설치·현재 메뉴·작업 순서 |
| [구조 점검과 확장 설계](ARCHITECTURE_REVIEW.md) · [수정 검증](results/architecture-refactor.md) | 최초 감사와 후속 책임 분리·검사·패키징 수정, 적용 범위와 남은 설계 |
| [개발·빌드](DEVELOPMENT.md) · [Pages](PAGES.md) | 소스 구성·빌드·정적 사이트 생성 |
| [코딩 기준](CODING_STANDARDS.md) · [UI 기준](DESIGN.md) | 구현·조회·데이터·화면 규칙 |
| [설계 결정](adr/README.md) · [주석 정책](COMMENT_POLICY.md) · [주석별 검토](results/comment-review.json) | 코드에서 옮긴 이유와 주석 추가 방지 검사 |
| [Node.js 예제](../examples/basic-web/README.md) | 앱에서 선택할 Dockerfile·Compose와 소스 |
| [Windows CLI 계약](results/windows-cli-contract.md) | 현재 launcher·프로필·엔진 연결과 검증 경계 |
| [Docker Desktop 데이터 가져오기](MIGRATION.md) | 현재 이미지·컨테이너·볼륨·파일/폴더 복사 절차와 보존·미지원 범위 |
| [독립 엔진 검사 절차](results/independent-engine-e2e-procedure.md) | 검증 스크립트의 실제 변경 범위·승인 조건 |
| [작업 지침](../AGENTS.md) | 실행·승인·데이터 보존 경계 |

## 현재 배포와 검증 상태

현재 파일·백신·원격 게시의 기준은 0.1.15 행이다. 나머지 릴리스 행은 이전 버전의 이력이며 현재 설치 파일의 검사로 합산하지 않는다.

| 문서 | 읽는 범위 |
| --- | --- |
| [0.1.15 공개·파일 대조](results/public-distribution-0.1.15.json) · [제작·검사](results/release-0.1.15.md) | 자동 시작·이전 분할·선택 삭제, 정확한 공개 파일·탐지 고지와 남은 검증 |
| [0.1.14 공개·파일 대조](results/public-distribution-0.1.14.json) · [제작·검사](results/release-0.1.14.md) | 조회 120초·승인 시간 수정, 공개 파일·SHA-256·탐지 고지와 남은 검증 |
| [조회 시간 초과 후속 수정](results/migration-timeout.json) | 불필요한 프록시·플러그인 준비 제거와 단계별 진단. 공개 0.1.14에 포함 |
| [0.1.13 공개 배포](results/public-distribution-0.1.13.md) · [제작·검사](results/release-0.1.13.md) | 전체 선택·정상 중지·파일/폴더 복사·실행 상태 유지, 정확한 공개 파일과 백신 검사 |
| [0.1.12 공개 배포](results/public-distribution-0.1.12.md) · [제작·검사](results/release-0.1.12.md) | 경로·CLI 초기화·가져오기 정렬 수정, 앱 탐지 1건·미서명 고지 및 정확한 공개 파일 대조 |
| [0.1.11 공개 배포](results/public-distribution-0.1.11.md) · [제작·검사](results/release-0.1.11.md) | 데이터 가져오기·설치/시작 수정, 정확한 EXE·ZIP·SHA-256·백신과 남은 실제 이전 검사 |
| [0.1.10 보안 개발판 공개](results/public-distribution-0.1.10.md) | 정확한 새 배포 파일·SHA-256·백신·실제 엔진 검사와 미서명 공개 승인 |
| [요청·검증 현황](REQUEST_STATUS.md) · [배포 전 점검](results/production-readiness.md) | 구현·실행 확인·미검증의 현재 요약 |
| [보안 점검과 수정](results/security-review-20261119.md) | 인증·시크릿·입력·웹 보호의 적용 범위, 의존성 갱신과 남은 권고·검사 결과 |
| [초기 0.1.10 제작·보류 기록](results/release-0.1.10.md) · [설치 전 제거 오류](results/installer-upgrade.md) | 제작 완료와 Microsoft 탐지 보류, 버전 독립 경로 복구 소스 수정·현재 PC 등록 복구. 실제 업그레이드·그 시점의 새 설치판 제작과 구분. 이후 제작은 0.1.13 기록 참조 |
| [0.1.9 공개 배포](results/public-distribution-0.1.9.md) · [제작·검사](results/release-0.1.9.md) | Release 첨부 4개·체크섬·VirusTotal, 자동 시작·일괄 작업·제거 알림 대기 변경과 미검증 범위 |
| [0.1.7 릴리스](results/release-0.1.7.md) · [이벤트 자동 갱신](results/engine-events.md) | 실제 앱 24개·CLI 4개·패키지 검증, DockSlate WSL 재시작·기존 SQL 실행 상태 복원 |
| [0.1.6 제작 기록](results/release-0.1.6.md) · [고정 공개 검사](results/public-release-0.1.6.json) | 2026-10-31 빌드·패키지·공개 파일 검사 |
| [실제 재설치](results/reinstall-recovery.md) | 2026-11-02 이 PC의 빈 엔진 재설치·앱·CLI 확인 |
| [가이드 촬영](results/guide-video.json) | 0.1.6 예제 빌드·실행·영상 검사. 로컬 media는 Git 제외 |
| [서명·보안 상태](results/code-signing.md) | 미서명과 과거 접근 경고의 조사 한계 |
| [WSL 커널 기록](results/cve-2026-98432-wsl.md) | 해당 PC·시점의 커널 적용. 앱 설치 파일이나 다른 장비의 패치 보증으로 사용하지 않음 |
| [문서·로컬 정리 검사](results/documentation-maintenance.json) | 날짜별 문서·링크 검사와 임시 파일 정리. 2026-11-23 갱신은 별도 필드에 기록 |

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

[개발판 고지](../licenses/THIRD_PARTY_NOTICES.md)는 0.1.15다. 과거 버전의 고지는 해당 Release에 포함된 파일을 기준으로 확인한다. [예전 docs 경로의 고지](downloads/THIRD_PARTY_NOTICES.md)는 0.1.5 호환 스냅샷으로 보존하며 현재 버전 안내로 사용하지 않는다.
