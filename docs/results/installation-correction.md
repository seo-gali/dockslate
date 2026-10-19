# 설치·CLI 통합 검증

설치판·Windows 명령 진입점·첫 실행 엔진 설치를 연결하는 작업입니다. 문서 지침 정리 PR과 별개이며 아직 전체 완료 상태가 아닙니다.

| 항목 | 확인한 결과 |
| --- | --- |
| 기존 엔진 보존 | 실제 등록 경로의 DockSlate 엔진·keepalive 확인. 기존 D: 데이터 위치 유지 |
| Windows CLI | 오프라인 릴리스 빌드 통과. 새 실행 파일의 실제 명령 검증은 남음 |
| 첫 실행 설치 화면 | TypeScript·프런트엔드 빌드와 Rust 검사 통과. 새 EXE의 실제 화면 검증은 남음 |
| 설치 도구 | 공식 NSIS·Tauri 보조 DLL의 고정 해시 일치, 설치 hook 컴파일 통과. 실제 설치·제거는 남음 |
| 설치판 전체 컴파일 | 실패. 기본 `win.bmp`와 자체 텍스트 payload를 NSIS File 명령이 읽지 못함. 같은 파일의 Windows 읽기·크기 조회는 성공했으며 원인은 미확정. 설치 파일은 제공하지 않음 |
| Dockerfile 파일 선택 | 이전 승인 EXE에서 실제 Windows 선택 창 → 빌드 → 격리 컨테이너 실행 통과 |
| Compose 파일 선택 | 선택·구성 확인·위험 입력 거절 통과. 실제 빌드 실패 재현 |

Compose 실패는 없는 최상위 `volumes`·`networks`를 정규화하면서 JSON `null`로 삽입한 데서 발생했습니다. Compose는 `volumes: null`을 매핑 오류로 거절합니다. 없는 항목은 생략한 채로 유지하고, 있는 매핑만 수정하는 것이 수정 계약입니다. 파일 잠금 조건은 완화하지 않습니다.

수정 후 `cargo check --locked --offline`과 Windows 앱 릴리스 빌드는 통과했습니다. 앱 후보 SHA-256은 `441CE3E2665A513DC2F185F5B1CD37C0B8FDEEE4ABEE87743A00CE80A87D4414`이며 새 실행 파일은 실행하지 않았습니다. 이전 승인 EXE의 검증을 이 후보의 검증으로 간주하지 않습니다.

실제 파일 선택 결과와 격리 데이터 정리는 [네이티브 검증 기록](file-import-native-e2e.json)에 남겼습니다. 이 기록의 Compose 성공 여부는 `false`이며, 수정 후 재검증 결과로 대체하지 않았습니다. 기존 MongoDB와 리소스 ID 집합은 보존했습니다.

WSL 선택은 [기존 REA 근거](../research/rancher-desktop-1.24.0.md)를 재사용한 독자 설계입니다. 이번 작업에서 새 REA MCP 관찰을 확보한 것은 아닙니다. Windows 명령 진입점의 [지원 범위](windows-cli-contract.md)와 공식 [도구 검증](installer-tool-verification.json)을 별도로 기록합니다.
