# ADR 0004: 조회·화면·검증 계약

상태: 채택 · 기록일: 2026-11-24 · 기존 구현의 결정을 주석에서 이전함.

## 배경

조회 결과와 화면 설정은 필요한 데이터만 사용한다. 타입·프로세스 검사는 실제 사용자 데이터를 변경하는 E2E와 구분한다.

## 결정

원래 위치는 검토 기준 커밋 `c439a2e14748a769b24d0c70f9cc487358126cda`의 줄 번호다. C 번호는 [전체 분류](../results/comment-review.json)의 항목과 대응한다.

| 항목 | 원래 위치 | 유지할 결정 |
| --- | --- | --- |
| C17 | `scripts/tests/runtime-ready.test.mjs:11` | WSL 준비 검사는 명령 스텁만 사용하며 실제 WSL·서비스·레지스트리를 변경하지 않는다. |
| C18 | `scripts/verify-engine-restart.mjs:14` | daemon이 재생성하는 기본 네트워크는 ID 비교에서 제외하고 사용자 네트워크 ID는 비교한다. |
| C22 | `scripts/verify-tray-controls.ps1:45` | 네이티브 메뉴 핸들 조회는 공개 Windows MN_GETHMENU 메시지 0x1E1을 사용한다. 이 결정은 비공개 tray-icon 메시지 의존의 해결을 의미하지 않는다. |
| C32 | `src-tauri/src/bin/docker.rs:154` | Windows SHA-256 pseudo-handle을 사용한다. 대상 Windows 11은 이 Windows 10 이상 API를 제공한다. |
| C35 | `src-tauri/src/docker.rs:1139` | 통계 조회 작업 값의 하위 8비트는 요청 인덱스, 상위 8비트는 실행 상태로 사용한다. 인코딩·디코딩과 요청 수 제한을 함께 유지한다. |
| C36 | `src-tauri/src/engine_events.rs:15` | 원본 이벤트 속성 대신 변경 종류만 보내고 재연결 때 현재 목록으로 동기화한다. |
| C38 | `src-tauri/src/main.rs:344` | 첫 CLI 검사가 공유 플러그인을 준비한 뒤 나머지 읽기 전용 검사를 병렬 실행한다. |
| C51 | `src/ResizableColumns.tsx:38` | 열 너비 복원이 실패하면 기본 너비를 사용한다. 선택적인 로컬 설정 실패가 표 사용을 막지 않는다. |
| C52 | `src/ResizableColumns.tsx:97` | 열 너비 저장 실패는 현재 화면 조작을 중단하지 않는다. |
| C53 | `src/ResizableColumns.tsx:222` | 포인터 캡처가 실패해도 이미 등록한 window listener로 드래그 종료·취소를 처리한다. |
| C54 | `src/appearance.ts:26` | 로컬 설정 저장이 거부돼도 현재 테마·글꼴 크기는 적용한다. |
| C55 | `src/i18n.ts:36` | 로컬 설정 저장이 거부돼도 현재 세션의 언어 전환을 적용한다. |
| C56 | `src/ipc/commands.check.ts:4` | IPC 음성 타입 검사 함수는 컴파일만 하고 호출하지 않아 네이티브 백엔드나 실제 변경 요청을 실행하지 않는다. |
| C57 | `src/ipc/commands.check.ts:9` | 오타 명령명은 컴파일 오류여야 한다. @ts-expect-error는 오류가 사라져도 실패하는 실행성 검사 지시문으로 보존한다. |
| C58 | `src/ipc/commands.check.ts:11` | approved 값만 있고 승인 토큰이 없는 변경 요청은 타입 검사에서 거부해야 한다. 지시문은 보존한다. |
| C59 | `src/ipc/commands.check.ts:13` | IPC ID는 문자열이며 숫자 ID는 타입 검사에서 거부해야 한다. 지시문은 보존한다. |
| C60 | `src/ipc/commands.check.ts:15` | 필수 인수를 생략한 image_search는 타입 검사에서 거부해야 한다. 지시문은 보존한다. |
| C61 | `src/ipc/commands.check.ts:17` | 반환 타입은 명령 계약이 정하며 호출자가 다른 타입으로 바꿀 수 없다. 지시문은 보존한다. |
| C62 | `src/ipc/commands.check.ts:21` | snapshot 필드는 해당 명령의 결과 타입을 유지해야 한다. 지시문은 보존한다. |

## 영향

저장소·포인터 캡처가 거부돼도 화면 사용을 유지한다. 컴파일 음성 검사의 지시문과 격리 검사 경계를 보존한다.

[주석 정책](../COMMENT_POLICY.md) · [ADR 목록](README.md)
