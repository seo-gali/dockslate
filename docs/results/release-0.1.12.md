# 0.1.12 제작·검사

설치 경로 오판·공유 플러그인 준비·오류 안내와 가져오기 화면 정렬을 수정한 미서명 개발판이다. **DeepInstinct의 앱 탐지 1건을 확인한 사용자가 공개를 승인했다. 오탐으로 확정하지 않았다.**

| 파일 | bytes | SHA-256 |
| --- | --- | --- |
| DockSlate_0.1.12_x64-setup.exe | 41170226 | `7DCBA45906EB27F317A34926752BE217F10746A55A26EFAFE404BB9F55C37334` |
| DockSlate-0.1.12-windows-x64.zip | 54998782 | `C2601CD9A4FCE4CE2093B1DA2D4054178F0B09D1F53F9C26FA713D70DC58C683` |
| DockSlate-0.1.12-third-party-licenses.zip | 5194694 | `867F03ADD34B607D332991719E0A559819C024E0D9E2EECD8685D0FBE9AEF325` |

[전체 기록](release-0.1.12.json) · [백신 결과](virustotal-0.1.12.json) · [릴리스 노트](../releases/v0.1.12.md)

- Node 17개·Rust 보안 20개·PATH 11개·Windows 프로세스 7개·격리 CLI 6개, 실제 GUI 5개·정렬 6개·CLI 조회 3개 통과.
- ZIP 435개·설치 공통 431개·문서 5개와 설치 helper·버전을 대조했다. 공식 GitHub artifact digest도 일치했다.
- 기존 사용자 데이터·엔진·WSL 상태를 변경하지 않았다. 실제 전체 Desktop 이전·설치·제거·콜드 부팅·롤백과 정식 서명은 미완료다.
- 외부 검사는 시간 초과·실패·미지원을 구분하며, 남은 의존성 권고와 앱의 탐지를 해결했다고 표시하지 않는다.

## 공개 후 확인

[Release·홈페이지 공개 확인](public-distribution-0.1.12.json): 첨부 4개 SHA-256·GitHub digest, 사이트 CSS·JS·안내서, 새 체크섬과 옛 고지 주소 18개가 일치했다. 최종 소스·Windows CI도 성공했다. 의존성 권고 job은 push에서 실행하지 않았다.

완료 전 점검에서 문서 개요의 낡은 현재 버전·고지 안내와 Release의 상대 문서 링크를 바로잡았다. 임시 설치·게시 workflow와 입력 ZIP을 제거했다. 공개 파일 대조 후 격리 검사 프로필·설치 추출본·아티팩트 운반 ZIP 416,493,507 bytes를 정리했으며 실제 앱·엔진·기존 원본은 보존했다.

별도 요청한 결정 기록은 저장소 밖 `DockSlate-0.1.12-decisions.html`에 저장했다. 결과를 바꾼 선택 15개와 미확인 사항 4개를 적고 실제 1280×720 창에서 한 화면 표시를 확인했다.
