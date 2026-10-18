# 로컬 실행 파일·안내서 전달 검증

2026-10-18. 초기 전달에서는 앱을 실행하지 않고 빌드·패키징·브라우저 검사를 수행했다. 이후 명시 승인된 EXE의 [실제 화면 검증](interaction-workflows.md)을 추가했다. 아래 초기 검사 기록과 구분한다.

## 제공 파일

| 파일 | 용도 |
| --- | --- |
| `guide.html` | 파일로 바로 여는 다운로드·사용 안내·요청 현황. 외부 자산 없음 |
| `downloads/DockSlate.exe` | 최신 Windows x64 실행 파일 |
| `downloads/DockSlate-0.1.0-windows-x64.zip` | EXE·HTML 안내·체크리스트·검증 기록·라이선스 고지 |
| `downloads/artifacts.json`, `SHA256SUMS.txt` | 크기·해시·검증 제약 |

최종 EXE·ZIP의 크기와 SHA-256은 [배포 파일 기록](delivery-artifacts.json)에 남겼다. ZIP 내부 기록에는 포함된 EXE만 기록하고 ZIP 자체의 해시는 바깥의 `downloads/SHA256SUMS.txt`에 둔다. 디지털 서명은 없다. 보안 경고 원인은 아직 확인하지 못했으며 안전 판정을 주장하지 않는다.

ZIP은 로컬 검토용이다. 저장소에 바이너리를 커밋하거나 공개 릴리스를 업로드하지 않았다. 외부 라이선스 고지의 미확인 범위는 `THIRD_PARTY_NOTICES.md`에 남아 있다.

## 실행한 검증

| 명령 | 실제 결과 |
| --- | --- |
| `npm run build` | TypeScript·Vite 빌드 통과, 상대 자산 경로·dist 안내서 생성 |
| `scripts/desktop.ps1 -Mode build` | Windows release EXE 빌드 통과. 앱 미실행 |
| `npm run package:local` | EXE 해시와 빌드 기록 일치 확인 후 ZIP·해시 목록 생성 |
| `node scripts/verify-guide.mjs` | [10개 통과](guide-delivery-e2e.json) |
| `node scripts/verify-frontend-refinements.mjs .analysis/guide-browser-session.json` | 수정된 최신 배포 화면 [9개 통과](frontend-refinements-e2e.json) |
| `node scripts/inspect-bundle.mjs` | 상대 경로 변경 후 자산 크기 다시 측정 |

서명이 유효한 Chrome을 `.analysis/guide-browser-*`의 새 프로필로 실행했다. 기존 브라우저 프로필·Tauri 백엔드·엔진 모의 데이터는 사용하지 않았다.

- 루트 `index.html`과 `dist/index.html`을 실제 file://로 열어 안내·링크 이동 확인.
- 루트·dist 안내서의 EXE·ZIP 링크가 실제 파일을 가리키는지 확인.
- EXE·ZIP 다운로드 버튼을 눌러 저장한 파일과 원본의 SHA-256 일치 확인. 파일 실행 없음.
- 공유 HTML 다운로드·단독 열기·재다운로드·스크립트 예외 없음 확인.
- ZIP을 작업 폴더 안에서 풀어 안내서가 옆 EXE를 가리키는지 확인.
- 390px 화면 가로 넘침 없음, 데스크톱 화면 시각 확인.

## 설치 파일

사용자가 **추가 도구 없이 EXE·ZIP만 제공**하도록 선택했다. 별도 설치 프로그램은 제공하지 않으며 제작 도구도 추가하지 않았다.

## 남은 일

전체 요청은 [체크리스트](../REQUEST_STATUS.md)에 구현·검증·남은 작업으로 구분했다. 새 Dockerfile·Compose 가져오기 전체 경로, 최신 데이터 팝업, 인라인 볼륨 연결, 실제 압축 등은 여전히 미검증이다. 보안 경고가 해결된 것으로 처리하지 않는다.
