# 0.1.15 제작·검사

앱 실행 시 전용 엔진 시작, 컨테이너 선택 자동 시작, Docker Desktop 이전 분할·프로젝트 선택·완료 항목 숨김, 다중 태그 이미지 삭제와 삭제 대상 제외, 우클릭 메뉴 정리를 포함한다. 설치 EXE·ZIP·고지 ZIP의 내부 파일을 대조했다.

제작 소스: `9fd842f10dd4d2256750847e163e24c590d6805b`. 미서명 개발판이며 실제 설치·제거·부팅·전체 Desktop 이전은 미검증이다. 공개 상태와 새 백신 결과는 아래 전체 기록이 기준이다.

| 파일 | bytes | SHA-256 |
| --- | --- | --- |
| DockSlate_0.1.15_x64-setup.exe | 41026459 | `70B5244A88048388B17C6DA2B2C167F5C7C9849E18A55F3879B1C65DC426BEB9` |
| DockSlate-0.1.15-windows-x64.zip | 54874491 | `45575B63D112C6C048D1F4A74DED1734D297DCDF51FF3943FDD1DCE898AF7909` |
| DockSlate-0.1.15-third-party-licenses.zip | 5194696 | `E75F19F77EB369AF113B422C568329ED66491D16F2D1CC1766B2CCB314E3C745` |

- Node 32개, Rust 보안 37개, Windows PATH fixture 11개와 프로세스 7개를 통과했다.
- 실제 React 컴포넌트의 격리 화면 검사 9개는 네이티브 엔진 변경 시험으로 합산하지 않았다.
- 실제 0.1.15 포터블의 읽기 전용 실행에서 엔진 연결과 기존 컨테이너 6개, 미승인 변경 거절을 확인했다.
- 포터블 ZIP 435개·고지 410개 파일을 모두 대조했다. 설치 EXE 내부 공유 파일 431개·문서 5개·PATH 도우미·앱/CLI 해시·제품 버전을 대조했다. 텍스트 줄바꿈과 동등한 공식 도구 manifest JSON 표현 차이는 기록했다.
- 로컬 NSIS는 기존 PATH 도우미 읽기 오류로 실패했다. SHA 고정 workflow에서 입력 ZIP 8개 파일의 해시를 검증하고 EXE를 1회 포장했다. GitHub artifact 크기·SHA-256을 확인한 뒤 압축을 열었다. 설치 EXE는 실행하지 않았다.
- 기존 0.1.14 공개 파일은 유지한다.

[전체 제작 기록](release-0.1.15.json) · [소스 변경 검사](migration-batches-and-startup.json)
