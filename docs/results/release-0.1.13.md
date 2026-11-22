# 0.1.13 제작·검사

전체 선택·정상 중지·파일/폴더 복사·원래 실행 상태 유지를 포함한 새 앱과 CLI, 설치 EXE·포터블 ZIP을 만들었다. 미서명 개발 빌드이며 **이번 EXE·ZIP·앱·CLI를 각각 공개 검사했으며 모두 탐지 0건이다. 시간 초과·미지원은 [백신 기록](virustotal-0.1.13.json)에 구분한다. 이전 버전 결과를 재사용하지 않았다.**

| 파일 | bytes | SHA-256 |
| --- | --- | --- |
| DockSlate_0.1.13_x64-setup.exe | 41187337 | `5111310CD3DEACF12477D9D875A9C8499C12B4A6A5CA79A20E09459C975B0AB8` |
| DockSlate-0.1.13-windows-x64.zip | 55028090 | `D7A372A9CBDCE6B46944E830E87D0CCD682A4767359CF599C9798C08A16D8744` |
| DockSlate-0.1.13-third-party-licenses.zip | 5194698 | `42783CBEF56A9AEE18D77CC07FE646AD145575A844629557476D95E15D7E35D2` |

[전체 기록](release-0.1.13.json) · [이전 범위](../MIGRATION.md)

Node 17·Rust 보안 28·PATH 11·프로세스 7·격리 CLI 6·실제 CLI 조회 3·새 Windows GUI 5·정렬 6·실제 React fixture 6개를 확인했다. 승인한 새 볼륨 2개·컨테이너 4개의 정상 종료·파일/폴더 전송·읽기 전용·정리 검사 4개가 통과했고 기존 목록·상태를 보존했다. 초기 fixture는 이미지의 SIGINT와 TERM 핸들러가 달라 실패했으며 시험용 SIGTERM을 명시한 뒤 통과했다.

ZIP 435개·고지 410개·설치 공통 431개·문서 5개와 공식 GitHub artifact digest를 대조했다. 로컬 NSIS의 기존 파일 읽기 오류 후 SHA 고정 GitHub 포장 1회를 사용했다. 전체 Docker Desktop 이전과 운영 서비스, 전체 설치·제거·부팅·롤백은 미검증이다. 기존 0.1.12 배포 파일은 보존했다.
