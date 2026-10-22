# 컨테이너·정리 대상 표

| 변경 | 동작 |
| --- | --- |
| 초기 너비 | 기본 열과 저장된 열 모두 첫 표시 때 현재 가용 너비로 축소. 이후 사용자의 열 조절·저장은 유지 |
| 이미지 이름 | 이미 받은 로컬 이미지 목록으로 저장소·태그를 표시하고 ID를 보조 표시. 검색·상세에도 같은 이름 사용 |
| 정리 대상 날짜 | 이미지의 Created와 빌드 캐시의 CreatedAt을 전달. 확인할 수 없는 날짜는 미확인 |
| 정리 대상 열 조절 | 컨테이너와 같은 구분선·드래그·키보드 조절과 별도 너비 저장 |
| 정리 | 사용하지 않게 된 고정 열 너비 CSS 3개 제거 |

## 검증

- 수정 전 실제 표 컴포넌트에서 가용 958px에 표 1109px로 넘침을 확인했다. 수정 후 같은 경로는 958px로 맞춰졌고 종료 0이다.
- `node scripts/verify-table-layout.mjs .analysis/table-layout-native-session.json`의 실제 Windows 앱 검증 9개가 통과했다. [결과](table-layout-e2e.json)의 후보 EXE는 B66E9FE7로 시작한다.
- 1000·1200·1480px에서 컨테이너·정리 대상 표 모두 가로 넘침이 없었다. 저장된 넓은 열의 초기 축소, 이미지명과 ID·검색, 두 표의 드래그·저장, 실제 생성 시각 18개를 확인했다.
- 영문 정리 표는 별도 네이티브 브라우저 조작으로 1000px에서 가용·스크롤 너비 767px 일치를 확인했다. 이 검사를 자동 스크립트에도 추가했다. 추가 후 전체 재실행은 엔진이 중지 상태여서 수행하지 않았다.
- 검증은 조회와 화면 조작만 사용했다. 삭제·정리·엔진 시작·중지는 수행하지 않았다. 마지막 고정 너비 스타일 제거는 참조가 없는 선택자 정리다.

새 설치 파일의 생성·해시는 [설치 산출물 기록](installer-engine-integration.json)에서 확인한다. 새 설치판의 전체 재설치·제거는 자동 실행하지 않는다.

## 산출물

- [새 설치 EXE](../../downloads/DockSlate_0.1.0_x64-setup.exe)는 [Windows 빌드](https://github.com/seo-gali/dockslate/actions/runs/39767569820)에서 생성했다. 압축 파일의 공식 GitHub digest와 내부 EXE SHA-256을 확인했다.
- [새 ZIP](../../downloads/DockSlate-0.1.0-windows-x64.zip)도 같은 표 수정으로 갱신하고 내부 구성 요소 10개의 해시를 대조했다.
- 최종 `tauri build --no-bundle --ci -- --locked --offline`, `cargo check --bins --locked --offline`, `package-local.ps1`은 종료 0이다. 가이드에서 실제 새 EXE·ZIP·공유 HTML 다운로드 등 11개 검사도 종료 0이다.
- 엔진은 작업 전후 모두 중지 상태다. 최종 EXE의 GUI 재실행과 설치·제거는 하지 않았으며 서명·보안 경고 원인은 해결된 것으로 표시하지 않는다.
