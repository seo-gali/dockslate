# ADR 0003: 설치·PATH·런타임 준비

상태: 채택 · 기록일: 2026-11-24 · 기존 구현의 결정을 주석에서 이전함.

## 배경

기존 설치 경로와 PATH의 소유권을 유지하면서 systemd가 준비될 때까지 확인해야 한다.

## 결정

원래 위치는 검토 기준 커밋 `c439a2e14748a769b24d0c70f9cc487358126cda`의 줄 번호다. C 번호는 [전체 분류](../results/comment-review.json)의 항목과 대응한다.

| 항목 | 원래 위치 | 유지할 결정 |
| --- | --- | --- |
| C23 | `src-tauri/installer/hooks.nsh:1` | 설치 확장 진입점은 Tauri NSIS hook 계약에 따른다. 원래 참고 주소는 https://v2.tauri.app/distribute/windows-installer/#extending-the-installer 이다. |
| C24 | `src-tauri/installer/hooks.nsh:35` | Tauri가 구버전 제거기의 _?= 인수를 만들기 전에 설치 디렉터리를 복원한다. |
| C25 | `src-tauri/installer/hooks.nsh:153` | 전체 PATH 레지스트리 값은 NSIS 고정 길이 문자열 대신 .NET에서 처리한다. |
| C26 | `src-tauri/installer/hooks.nsh:198` | PATH 변경 알림 대기는 2초로 제한한다. 모든 창의 알림 수신을 보장하는 방식은 현재 계약이 아니며, 필요해지면 별도 프로세스를 검토한다. |
| C27 | `src-tauri/installer/user-path.ps1:29` | PATH를 쓰기 전에 소유한 항목을 기록해 중단된 설치도 자기 항목만 제거할 수 있게 한다. |
| C28 | `src-tauri/scripts/runtime-control.ps1:185` | 새 준비 검사를 이미 설치된 게스트에도 전달한다. |
| C29 | `src-tauri/scripts/runtime-ready.sh:1` | 셸 진입점의 /bin/sh shebang은 실행 지시문으로 보존한다. |
| C30 | `src-tauri/scripts/runtime-ready.sh:8` | WSL exec가 성공해도 systemd 관리자 소켓은 아직 응답하지 않을 수 있어 준비 상태를 별도로 확인한다. |
| C31 | `src-tauri/scripts/runtime-setup.sh:1` | 런타임 설치 스크립트의 /bin/sh shebang은 실행 지시문으로 보존한다. |

## 영향

업그레이드 경로·긴 PATH·중단된 설치를 보존한다. 느린 다른 창에 알림을 보내는 일에는 유한한 대기 예산을 둔다.

[주석 정책](../COMMENT_POLICY.md) · [ADR 목록](README.md)
