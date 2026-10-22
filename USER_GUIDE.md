# DockSlate 사용 안내

**로컬 안내서: `guide.html`**

내려받은 폴더에서 `guide.html`을 더블클릭하면 설치·사용 방법을 볼 수 있습니다. 안내서에 연결된 실행 파일을 함께 전달받았을 때 다운로드 버튼을 사용할 수 있습니다. 상단 **안내서 HTML 다운로드**와 **인쇄 / PDF**도 지원합니다. 현재 파일은 미서명 개발 빌드입니다.

GitHub Pages용 공개 사이트는 별도로 빌드합니다. 로컬 사이트 미리보기는 `site-dist/index.html`, Pages에 게시하는 메인 페이지는 `site-publish/index.html`입니다. 루트 `index.html`은 앱 화면의 진입점입니다. [웹사이트·Pages 안내](docs/PAGES.md)

| 내용 | 바로가기 |
| --- | --- |
| EXE·ZIP, 필요한 환경, 첫 실행 | [시작하기](guide.html#start) |
| 상세·로그·터미널·파일 트리 | [컨테이너](guide.html#containers) |
| 실행 설정·명령어·삭제 승인 | [이미지](guide.html#images) |
| Dockerfile·Compose 가져오기 | [파일로 빌드](guide.html#builds) |
| 볼륨·네트워크 생성과 연결 | [리소스](guide.html#resources) |
| 언어·테마·폰트·런타임·디스크 | [설정](guide.html#settings) |
| 정상 종료·앱 제거·deployment.yaml·보안 경고 | [자주 묻는 질문](guide.html#questions) |
| 구현한 것과 검증이 남은 것 | [작업 현황](guide.html#status) · [상세 체크리스트](docs/REQUEST_STATUS.md) |

HTML만 공유하면 프로그램 EXE가 함께 전달되지는 않습니다. 실행 파일이 필요하면 설치 EXE 또는 전체 ZIP도 함께 전달하세요. 미서명 상태·미해결 접근 경고 등 [서명·보안 상태](docs/results/code-signing.md)를 확인하세요.
