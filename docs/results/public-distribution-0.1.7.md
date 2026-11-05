# 0.1.7 공개 배포 확인

2026-11-05. 기존 0.1.7 파일을 변경 없이 [GitHub Release](https://github.com/seo-gali/dockslate/releases/tag/v0.1.7)에 게시했다. 현재 표시는 미서명 개발판에 맞춘 **Pre-release**다.

- 설치 EXE·포터블 ZIP·고지 ZIP·SHA256SUMS.txt 네 첨부 파일을 실제 공개 주소에서 받아 크기·SHA-256을 대조했다. 태그와 릴리스 설명도 소스와 일치했다.
- [VirusTotal 결과](virustotal-0.1.7.json): 설치 EXE 0/66, 포터블 ZIP 0/67. EXE 시간 초과 4개·미지원 5개, ZIP 미지원 7개를 함께 기록했다. 해당 조회 시점의 결과다.
- 체크섬을 일부러 바꾸면 사이트 출력 교체 전 종료 1로 거부했고, 복원 후 종료 0과 동일 체크섬 복사를 확인했다.
- workflow 외부 참조 6곳은 기존부터 40자리 SHA였다. 버전 교체 없이 고정을 유지하고, 25개 자체 검사 및 실제 태그·로컬 composite 실패/성공 검증을 포함한 린트를 추가했다. PR은 검사만 수행하고 Pages 빌드·배포는 린트 성공 뒤 실행한다.
- 검사기는 블록 매핑·한 줄 리터럴 uses를 요구한다. 외부 GitHub 참조는 40자리 SHA, Docker 참조는 64자리 sha256, 로컬 액션은 저장소 안에서 재귀 확인한다. 외부 액션의 런타임 다운로드와 러너 이미지를 고정하는 검사는 아니다.
- 공식 upload-pages-artifact의 고정 메타데이터도 확인했다. 내부 upload-artifact 호출 역시 전체 SHA로 고정돼 있었다. 일회성 Release 게시 workflow는 main에서 제거했다.

사이트의 주 다운로드·Release·지문표·검사 링크 7개를 브라우저에서 대조했고 1366px·390px에서 가로 넘침·스크립트 오류가 없었다. 게시 후 공식 사이트의 HTML·CSS·JavaScript·가이드·체크섬 5개를 다시 받아 빌드 결과와 일치함을 확인했다. [Pages 실행](https://github.com/seo-gali/dockslate/actions/runs/42024561247)과 [SHA 고정 검사](https://github.com/seo-gali/dockslate/actions/runs/42024561272)도 성공했다. 실제 조회 시각과 결과는 [구조화 기록](public-distribution-0.1.7.json)에 남겼다.

실행 파일을 다시 만들거나 설치·엔진·사용자 DB·커널·전역 인증 설정을 변경한 작업이 아니다. 서명 추가·실제 설치/제거·장시간 부하는 이번 후속 작업에 포함하지 않는다.
