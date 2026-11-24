# ADR 0002: Docker Desktop 이전 경계

상태: 채택 · 기록일: 2026-11-24 · 기존 구현의 결정을 주석에서 이전함.

## 배경

기존 Desktop을 읽는 경로와 DockSlate 엔진을 변경하는 경로는 준비 작업과 신뢰 경계가 다르다.

## 결정

원래 위치는 검토 기준 커밋 `c439a2e14748a769b24d0c70f9cc487358126cda`의 줄 번호다. C 번호는 [전체 분류](../results/comment-review.json)의 항목과 대응한다.

| 항목 | 원래 위치 | 유지할 결정 |
| --- | --- | --- |
| C33 | `src-tauri/src/bin/docker.rs:290` | 명시된 Desktop 원본의 core 명령에는 DockSlate 소유 프록시·플러그인 준비를 실행하지 않는다. 소유 엔진과 플러그인 명령의 검증은 유지한다. |
| C39 | `src-tauri/src/migration.rs:120` | CLI inspect 실패의 원시 출력에는 설정값이 들어갈 수 있어 안전한 명령·단계·상태만 반환한다. |
| C40 | `src-tauri/src/migration.rs:395` | 볼륨 사용자 확인은 상태 메타데이터만 읽고 선택하지 않은 컨테이너의 환경 변수를 읽지 않는다. |
| C41 | `src-tauri/src/migration.rs:900` | 정상 중지 요청의 클라이언트 시간 초과는 컨테이너에 SIGKILL을 보내는 것으로 바꾸지 않는다. 원본 데이터를 보존하고 실패를 보고한다. |
| C42 | `src-tauri/src/migration.rs:977` | 볼륨 복사 helper는 이미지의 VOLUME 경로를 덮어써 불필요한 익명 볼륨을 만들지 않는다. |

## 영향

원본 설정값을 오류에 노출하지 않고 필요한 메타데이터만 읽는다. 정상 중지의 시간 초과를 강제 종료·데이터 삭제로 바꾸지 않는다.

[주석 정책](../COMMENT_POLICY.md) · [ADR 목록](README.md)
