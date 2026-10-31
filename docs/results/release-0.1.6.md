# 0.1.6 개발판 검증

2026-10-31. 호출되지 않는 컨테이너 명령 생성·로그 조회 경로와 미사용 import를 제거하고, README·기준 문서와 공개 사이트 생성물을 정리했다. 앱 루트 버전을 0.1.6으로 변경했으며 의존성 버전·엔진 데이터 형식은 유지했다. [정리 근거](maintenance-review.md).

앱·CLI 빌드와 locked/offline Rust 검사·TypeScript 미사용 검사·라이선스 검사는 종료 0이다. 새 앱의 PE·엔진 응답 버전은 0.1.6이며 [읽기 전용 Windows 화면 검사](release-0.1.6-native.json) 10개와 CLI 버전 명령 4개를 통과했다. 기존 컨테이너 ID·이름·상태를 보존했다. 포터블 591개·고지 ZIP 378개 파일을 원본과 대조했다. 설치 파일 내부 대조도 완료했다. 로컬 NSIS는 PATH 도우미 읽기에 실패해 검증된 ZIP으로 GitHub 설치 패키징 1회를 사용한다.

WSL 커널 패치는 앱 설치 파일에 포함하지 않는다. 별도 승인으로 적용한 호스트의 [커널 수정](wsl-kernel-fix.json)과 [기존 사용자 컨테이너 검사](wsl-user-containers.json)는 해당 환경·시점의 결과다. 다른 사용자의 WSL을 자동으로 업데이트하지 않는다.

미서명 개발판이다. IObit 접근 알림의 원인 확정·새 백신 검사·실제 설치와 제거·전체 회귀·앱 롤백은 미검증이다. [보안 상태](code-signing.md).

승인된 [GitHub 설치 패키징 1회](https://github.com/seo-gali/dockslate/actions/runs/41198902798)가 성공했다. 입력 커밋 `2d229466e5176d3118c25df3a271b6e8d7c33fbc`의 검증된 ZIP에서 앱·CLI를 재컴파일 없이 복원했다. GitHub artifact 13041612875의 크기·다이제스트를 대조하고, 설치 파일을 실행하지 않은 상태에서 내부 앱·CLI·라이선스/소스 375개·공식 구성 파일 8개·예제 5개·문서 13개·PATH 도우미를 확인했다. 임시 workflow를 제거했다. 패키지 문서는 생성 시점 스냅샷이며 이후 최종 배포 증거는 저장소에서 관리한다.

| 파일 | 크기 | SHA-256 |
| --- | --- | --- |
| `DockSlate_0.1.6_x64-setup.exe` | 49268432B | `E8699FEDC93C31081E73D792BB55A596AA326EA988ABD3C8BD5575144D6B8525` |
| `DockSlate-0.1.6-windows-x64.zip` | 63318278B | `20E330D17DDC42F3A0BD1BB3E090EC44F9FD1D946F89B2F0F5F9E527A4F25928` |
| `DockSlate-0.1.6-third-party-licenses.zip` | 5161524B | `E302A23FE9024B1811994B77C6C7B6FEADE4649EF8AF26E4F49BE621B324104B` |

사이트 [실제 Chrome 검사 27개](pages-e2e.json)와 [독립 안내서 검사 7개](guide-delivery-e2e.json)는 종료 0이다. 루트·미리보기 HTTP, 실제 다운로드 3개, 키보드, 1440·1024·390px, JavaScript 비활성, canonical·Sitemap·404와 앱 진입점 분리를 검사했다. 검증 후 `site-dist/`·전용 브라우저 프로필·설치 추출물과 복제 다운로드를 제거했다. 원본 ZIP과 파일별 일치한 구버전 포터블과 앱 다운로드 2개를 정리했고, 과거 고지 ZIP URL은 보존한다. [정리 범위](repository-cleanup.json). [실제 공개 URL 검사](public-release-0.1.6.json)에서 설치 EXE·포터블·고지 ZIP 3개의 HTTP 200·크기·SHA-256과 루트 HTML 일치, 구버전·구형 사이트 URL 6개의 HTTP 404, 기존 고지 URL 6개의 유지와 원격 임시 workflow 부재를 확인했다.

현재 `dist/`와 `site-dist/` 생성물은 검증 후 제거했다. 원본 `src/`·`src-tauri/`·`site/`는 보존했으며 각각 앱 빌드·사이트 미리보기 명령으로 다시 생성한다.
