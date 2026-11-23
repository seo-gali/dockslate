# 0.1.14 제작·검사

Docker Desktop 조회 제한을 명령당 30초에서 120초로 늘리고, 검사 완료 뒤부터 승인 유효 시간 120초를 계산하는 수정본이다. 원본 조회에서 불필요한 DockSlate 프록시·Compose/Buildx 준비를 생략하고 실패한 엔진·명령 단계를 표시한다. 원본 중지·복사 제한과 승인·소유권 검사는 유지한다. 최신 사용·개발·웹 안내도 동봉했다.

설치 EXE·포터블 ZIP·고지 ZIP 제작과 파일 대조를 완료했다. 소스는 `eb30c7f2985863fc209dff99813501bc9ccb8189`로 푸시했다. 공개 홈페이지의 다운로드는 0.1.13을 유지하며 새 0.1.14 GitHub Release·백신 공개 제출은 수행하지 않았다.

| 파일 | bytes | SHA-256 |
| --- | --- | --- |
| DockSlate_0.1.14_x64-setup.exe | 41185627 | `D721348660753ABA24A844ABF368350CEC54223B32F3823DFE79EA3BAAA6B53F` |
| DockSlate-0.1.14-windows-x64.zip | 55032221 | `01EEFB5456A2368363734FC7F8F802E468A66031486A8BC765116060DBACEC53` |
| DockSlate-0.1.14-third-party-licenses.zip | 5194697 | `FC7B6456E539E0DAD30D1D3A9626CB54D2697822D10C1CAD7EE835FC06213FE1` |

[전체 기록](release-0.1.14.json) · [조회 수정·회귀 검사](migration-timeout.json)

- `npm run check`: Node 17개·IPC 계약 89개/네이티브 등록 92개·TypeScript·문서·workflow·패턴 시크릿 검사, 종료 0.
- `scripts/check-windows.ps1 -Offline`: 격리 AppData의 Rust 보안 30개·PATH 11개·실제 프로세스 7개, 종료 0. 사용자·시스템 PATH와 엔진 변경 없음.
- 최적화 앱·CLI 빌드 종료 0, 오프라인 CLI 6개·실제 CLI 조회 3개·Windows GUI 5개·정렬 6개·정상 트레이 종료 0. 종료 뒤 WebView의 class 1412 진단은 별도 기록했다.
- ZIP 435개·고지 410개·설치 공통 431개·문서 5개와 내장 helper·PE 버전을 대조했다. 문서는 제작 시점 스냅샷이며 이후 온라인 기록 갱신을 위해 다시 포장하지 않았다.
- 로컬 NSIS는 기존 `user-path.ps1` 읽기 오류로 1회 실패했다. 보호 설정을 변경하지 않고 승인된 [GitHub 포장 1회](https://github.com/seo-gali/dockslate/actions/runs/45182304147)를 사용했다. 공식 artifact digest·첨부 지문과 원본 0.1.13 파일 3개를 확인했다. 원격 소스·Windows CI도 성공했으며 정기 의존성 검사는 push에서 skipped였다.

미서명 개발판이다. 새 파일의 백신 검사·실제 사용자 PC의 시간 초과·전체 Desktop 이전·운영 서비스·설치/제거/부팅/롤백은 미검증이다. 의존성·엔진·WSL 커널은 갱신하지 않았고 기존 사용자 데이터는 보존했다.

임시 workflow·빌드 입력을 Git에서 제거하고 검사 사본 791개(212005369 bytes)를 정리했다. 완성 파일과 기존 0.1.13 원본은 보존했으며 저장소 밖 결정 요약 HTML의 1,280×720 한 화면 배치를 확인했다.
