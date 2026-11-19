# DockSlate 0.1.10 보안 개발판 공개

2026-11-20. [GitHub Release](https://github.com/seo-gali/dockslate/releases/tag/v0.1.10)에 새 보안 설치 EXE·포터블 ZIP·타사 고지 ZIP·SHA256SUMS를 게시했다. 사용자가 정식 서명 수단이 없음을 확인하고 **미서명 prerelease 공개를 명시적으로 승인**했다. 실제 공개 다운로드 네 파일의 크기·SHA-256과 GitHub digest, 태그 commit·릴리스 노트를 대조했다. 구 0.1.9·0.1.7 Release는 보존했다. 홈페이지 전환 결과는 [배포 영수증](public-distribution-0.1.10.json)의 websitePublished로 확인한다.

VirusTotal 결과는 설치 EXE 정상 분석 59·시간 초과 11·미지원 4, ZIP 정상 63·시간 초과 4·미지원 7이며 탐지는 모두 0이다. 자체 앱·CLI도 정확한 해시의 정상 분석 71·미지원 3, 탐지 0을 확인했다. [정확한 해시·범위](virustotal-security-0.1.10.json). 큰 다중 파일 ZIP 내부 전체의 검사나 안전성 보증으로 기록하지 않는다.

[실제 엔진 18개·설치 EXE/ZIP 내부 대조](security-release-0.1.10.md)와 [10개 배포 점검](production-readiness.md#0110-보안-개발판-공개)을 구분한다. 기존 컨테이너 5개·이미지·볼륨·네트워크·엔진 상태를 보존했다. 실제 설치/제거·로그인/재부팅·WSL 재시작·롤백은 미실행이며, 의존성 권고 12개 버전과 정식 서명은 남아 있다.

동봉 문서는 제작 시점의 스냅샷이다. 이 게시·백신·엔진 확인은 저장소의 후속 기록이며, 구 0.1.10 탐지 원본의 오탐 해소로 간주하지 않는다. 옛 조사 파일 네 개는 같은 해시로 로컬 분석 폴더에 보존했다.
