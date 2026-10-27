# WSL 가상 머신의 VHDX 잠금 해제

사용자 화면과 같은 실패를 실제 전용 엔진에서 재현했다. `runtime_stop`은 Docker 서비스를 중지하고 `wsl --terminate DockSlate`를 실행한다. WSL 배포판 목록은 중지 상태였지만 `vmmemWSL`·`vmwp`가 남았고, Windows의 단독 파일 열기는 공유 위반, Virtual Disk API는 접근 거부를 반환했다. 실행 중 배포판이 없다는 사실만으로 VHDX 잠금 해제를 보장할 수 없다.

영향 범위는 `WslDisks.tsx` → Tauri 명령 등록 → `wsl.rs`의 승인 토큰 → `wsl-disks.ps1`이다. 전용 배포판 중지 동작은 유지하고, 실패 화면에 **WSL 가상 머신 종료**를 별도 승인 작업으로 추가한다. 현재 등록된 모든 배포판과 대상 디스크·영향을 표시하고, 실행 중 배포판이 있거나 소유 정보·등록 목록이 변경되면 차단한다. 종료 후 디스크를 다시 검사하며 실제 압축은 새 사전 검사·승인으로 분리한다.

`wsl --shutdown`은 전체 WSL 2 가상 머신에 영향을 준다. [Microsoft 명령 설명](https://learn.microsoft.com/en-us/windows/wsl/basic-commands#shutdown)을 확인했다. 사용자 승인 없이 실제 전체 종료나 원본 VHDX 압축은 실행하지 않는다. 안전 검사 우회·데이터 삭제·Hyper-V 추가 설치는 하지 않는다.

2026-10-27 실제 Windows 검증을 마쳤다. 검사한 EXE SHA-256은 `E20E1E20BF1616E74BD3F0662676EF2AD3DA2968B1523393FF55EC48FE0BB560`이다.

| 검사 | 실제 결과 |
| --- | --- |
| `powershell -NoProfile -File scripts/desktop.ps1 -Mode build` | 종료 0, TypeScript·Vite·Windows release 성공 |
| `node scripts/verify-wsl-recovery.mjs .analysis/wsl-recovery-session.json .analysis/inspect-lifecycle-resume.json docs/results/wsl-recovery-e2e.json` | 종료 0, 네이티브 검사 8개. 실제 잠금 재현·복구 UI·동의 전 실행 차단·취소·실행 중 배포판 거절·압축 토큰 구분 확인 |
| 사용자 승인 뒤 실제 복구 버튼 실행 | 공유 WSL 가상 머신 종료 후 단독 파일 열기·디스크 분리·원본 확인 통과, 자동 재검사 확인 |
| 관리자 압축 사전 검사 | 9개 모두 통과. 현재 소유 정보·파일 지문에 묶인 새 검사로 실행 |
| 실제 원본 압축 | `CompactVirtualDisk` 성공. 5,125,439,488 → 5,124,390,912 B, Windows 파일 할당 공간 **1,048,576 B(1 MiB)** 회수. 백업 없음 |
| 압축 후 엔진 재실행 | Moby 연결 성공. 기존 컨테이너 ID·상태, 볼륨 메타데이터 전체, 이미지 ID, 네트워크 설정·기존 참조 유지. 엔진 중지 상태 복원 |

[승인 전 네이티브 검사](wsl-recovery-e2e.json)와 [사용자 승인·실제 종료·원본 압축·사후 확인](wsl-compaction-e2e.json)을 구분한다. 관리자 WebView의 디버깅 차단은 유지했으며 실제 압축은 EXE에 포함되는 동일 PowerShell 백엔드를 관리자 검증 드라이버에서 실행했다. **관리자 GUI의 압축 버튼까지 클릭하는 전체 경로는 미검증**이다. 도구의 .NET 속성·이전 디스크 ID 조건 오류는 원본 압축 시작 전에 중단됐고, 수정 후 종료 0을 확인했다.

재시작 후 기본 `bridge` 네트워크 ID가 바뀌었다. 이름·드라이버·IPAM·기존 컨테이너 참조는 동일하며 별도 사용자 네트워크 변경·삭제는 없었다. 원래 DB 컨테이너는 중지 상태를 유지했고 DB 내용 조회·삭제·초기화는 하지 않았다.

현재 구현은 `CompactVirtualDisk`로 0이 채워진 블록을 회수한다. 압축 전 Linux 파일시스템의 미사용 블록을 알리는 `fstrim` 단계는 없다. 이번 회수량은 약 0.02%이며, Linux의 실제 여유 공간이나 회수 가능한 최대 공간을 측정한 결과가 아니다. 압축 API 호출 성공과 충분한 공간 회수를 구분한다.

추가 종료 확인이 끝나기 전에 검증 창을 닫은 뒤에는 승인된 동일 대상의 백엔드 종료와 읽기 전용 검사를 별도로 완료했다. 최종 실행 중 배포판 0개, VHDX 분리·단독 파일 열기 통과다. 엔진 재실행·중지 검사를 거친 **최종 파일은 5,132,779,520 B**로 압축 직후보다 다시 커졌다. 압축 순간의 1 MiB 회수와 구분하며, 대규모 공간 회수·DB 무결성 검사·공개 설치판 갱신을 뜻하지 않는다.
