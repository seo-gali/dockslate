# 0.1.10 보안 배포 후보

새 보안 설치 EXE·ZIP 제작과 실제 엔진 검증·백신 확인은 완료했다. 소스는 build commit `3e653ad`로 푸시했다. **정식 서명은 미완료이며, 사용자가 2026-11-20 미서명 개발판 공개를 명시적으로 승인했다.** 기존 공개판 0.1.9와 구 0.1.10의 탐지 원본은 보존한다. 실제 게시 결과는 아래 기계 판독 기록의 `published`와 GitHub 영수증으로 구분한다.

| 파일 | bytes | SHA-256 |
| --- | --- | --- |
| DockSlate_0.1.10_x64-setup.exe | 41122883 | `7283FB8DEA405A362578A993846E755C3F6E8450909C514BE0347F51BEAB765D` |
| DockSlate-0.1.10-windows-x64.zip | 54943992 | `8457ABB2D0E30FE73F58701D522939677AC414F0A85CB03EA725CB01A43B1145` |
| DockSlate-0.1.10-third-party-licenses.zip | 5194696 | `285991B5CD4EE4C0B0E48CA91C199354C7C58A4CF7B4163864E5D1FEB6B2FB56` |

[릴리스 노트](../releases/v0.1.10.md) · [기계 판독 기록](security-release-0.1.10.json) · [백신 결과](virustotal-security-0.1.10.json). 원격 빌드·소스 CI, 실제 엔진 18개, 설치 EXE 내부 430개·문서 4개와 ZIP 434개를 대조했다. 원격 checkout의 LF/CRLF 때문에 달라진 manifest 원문 해시 두 경우만 검증 후 동등하게 취급했으며, 실행 파일이나 기타 manifest 필드는 완화하지 않았다.

정식 서명·설치/제거·WSL 재시작·롤백은 미실행이다. 기존 컨테이너·DB·다른 배포판은 보존했다. Windows Defender는 비활성 상태여서 로컬 검사 성공으로 기록하지 않았다. 동봉 도구의 권고 12개 버전은 앞선 보안 보고서에 남아 있다.
