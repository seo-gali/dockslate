# 0.1.11 제작·검사

2026-11-21. 설치 EXE·포터블 ZIP·법적 고지 ZIP 제작과 검사 완료, GitHub Release에 공개했으며 4개 공개 다운로드의 크기·SHA-256을 확인했다. 앱과 설치판은 미서명이며 기존 공개 0.1.10은 보존한다.

| 파일 | bytes | SHA-256 |
| --- | --- | --- |
| DockSlate_0.1.11_x64-setup.exe | 41167731 | `32D74A5FAC329D183965B66B358002683A14C919A4B8664651C91DAA616D375E` |
| DockSlate-0.1.11-windows-x64.zip | 54998141 | `6CDCBBD2A442BA79251963EAEE7FB93B8732E83A12AF5C61B2AC33D123EC83F8` |
| DockSlate-0.1.11-third-party-licenses.zip | 5194697 | `25D9FE40CCFE9ABCA0E1567A1B9C6CC7B4B58C200AE5668BCD96392D2B5AFCD0` |

[전체 기록](release-0.1.11.json) · [백신 결과](virustotal-0.1.11.json) · [릴리스 노트](../releases/v0.1.11.md)

- 소스·Windows CI와 Node 16개·Rust 18개·PATH 11개·Windows 프로세스 7개·격리 CLI 6개 통과.
- ZIP 435개 파일 전체, 설치 EXE와 공통 payload 431개·문서 5개, 설치 PATH helper와 버전 대조.
- 정확한 새 실행 파일의 실제 Windows GUI·IPC 검사 5개, 읽기 전용 엔진 조회, 네이티브 트레이 정상 종료 0. 기존 6개 컨테이너·5개 이미지를 조회했으며 사용자 데이터 변경 없음.
- 앞선 승인 격리 시험은 볼륨 2개·미실행 컨테이너 3개에 한정하며 내용·UID/GID·권한 복사와 원본 쓰기 거절·정리 통과.
- 새 EXE·ZIP·앱·CLI의 탐지는 0건이나 시간 초과·실패·미지원이 있다. ZIP은 다중 파일 내부 전체 검사로 간주하지 않는다.
- Docker Desktop과의 전체 이전, 전체 설치·제거·WSL 재부팅·로그인·재부팅·실제 롤백은 미검증이다. 상위 구성 요소 권고와 정식 서명 미완료도 유지한다.
