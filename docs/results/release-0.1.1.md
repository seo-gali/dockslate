# DockSlate 0.1.1 검증

2026-10-29 Windows 네이티브 앱에서 검증했다. 앱 SHA-256은 `F7F5ED582AF19840F6B6181F1BEDDF47C39D705F569E9B379FDE7CAEBD9A4CC3`이다. 화면과 실제 Rust 명령을 사용했으며 백엔드를 모의 구현하지 않았다.

| 검증 | 결과 |
| --- | --- |
| `npm run build` | 종료 0 |
| `cargo check --manifest-path src-tauri/Cargo.toml --locked --offline` | 종료 0, 프로젝트의 기존 Rust 도구 사용 |
| `powershell -NoProfile -File scripts/desktop.ps1 -Mode build` | 종료 0, 최적화된 Windows EXE 생성 |
| [실제 UI·수정](ui-release-0.1.1.json) | 24개 통과: 전체 태그·ID·시각·참조, 최소 너비·키보드 조절, 번역, 수정 취소·승인·이름 변경·재생성·파일/볼륨 보존 |
| [실패 복구](container-edit-recovery-0.1.1.json) | 3개 통과: 점유된 포트로 재생성 실패 후 원래 ID·이름·설정·실행 상태·파일 복구 |
| [조건부 화면](ui-extra-0.1.1.json) | 7개 통과: 실제 Hub 검색·Compose 파일 선택, 한영·12/16px·1000/1200px 화면 |
| [정렬·필터·삭제 진행](table-controls-0.1.1.json) | 6개 통과: 숫자·날짜 정렬, 원래 순서 복원, 선택 필터, 실제 2개 삭제의 대상·처리 건수 알림 |
| CLI 버전 | 기존과 동일한 CLI SHA-256에서 Docker·debug·Compose·Buildx 4개 오프라인 검사 종료 0 |
| 라이선스 | 555개 구성 요소, 362개 고지문, 11개 소스 아카이브, 누락 0 |
| 설치 EXE | 승인된 GitHub Windows 빌드 [40854652031](https://github.com/seo-gali/dockslate/actions/runs/40854652031) 성공. 49,255,610바이트, SHA-256 `503E15CE5329AC37CE41C55974302E4DD2EE3FD113262BBE2FDCF883FA514892` |
| 설치판 내부·ZIP | 설치판 앱·CLI가 실제 검사한 해시와 일치. PATH 도우미·고지/소스 375개·인덱스·공식 구성 요소 8개·동봉 문서 9개 대조. ZIP 바이너리·고지 387개 대조 |

검증 명령은 해당 `scripts/verify-*.mjs`에 전용 세션 파일 `.analysis/ui-release-session.json`을 전달했다. `verify-ui-release.mjs`에는 `--isolated-container-edit`도 사용했다. 검증 세션은 개인 브라우저와 분리된 프로필이다.

사용자 승인 범위의 DockSlate 런타임과 고유 이름의 임시 BusyBox 컨테이너를 사용했다. 검증 컨테이너만 삭제하고 기존 컨테이너의 ID·이름·상태와 모든 볼륨을 보존했다. 기존 임시 볼륨 2개를 재사용했으며 검증용 네트워크와 파일 보존 이미지는 남겼다. DB 내용을 읽거나 삭제·초기화하지 않았다.

문서의 기존 말줄임/마우스 오버 규칙을 전체 값 표시로 고쳤다. 새 컨테이너에만 연결할 수 있다는 설명은 기존 컨테이너 수정·승인 재생성에 맞췄다. 고정 최소 너비는 실제 헤더·배지·버튼과 언어·글자 크기를 반영하도록 바꿨다. 5개 작업 메뉴·툴팁 전용 안내는 수정 메뉴·직접 표시로 정정했다. 이전 EXE 검증 기록은 당시 해시의 역사적 근거로 구분했다.

설치 파일 패키징·내부 해시는 [배포 기록](installer-engine-integration.json)에서 별도로 관리한다. 임시 workflow와 다운로드 폴더·사이트의 0.1.0 산출물을 제거했다. 동봉 문서는 빌드 입력 커밋 기준이며, 게시 후 다운로드 검증은 별도 기록한다. 실제 새 설치·제거, 전체 CLI/DB 회귀, 코드 서명, 과거 보안 경고의 원인·해소는 이번 검사 범위 밖이다. VHDX 압축·Prune·볼륨 삭제는 실행하지 않았다. 정식 프로덕션 준비 완료를 의미하지 않는다.
