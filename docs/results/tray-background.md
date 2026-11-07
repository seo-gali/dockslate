# Windows 트레이 후속 개발

공개 0.1.9를 유지한 후속 작업이다. 일반 창의 X는 앱을 종료하지 않고 트레이로 숨기며, 왼쪽 클릭으로 창을 다시 연다. 오른쪽 메뉴에는 열기·컨테이너·이미지·전체 새로고침·설정·완전 종료를 제공한다. 앱의 한국어·영어 선택을 메뉴에도 반영한다.

숨겨도 진행 중 작업을 계속한다. 완전 종료는 기존 다운로드·빌드·전송·압축·엔진 작업과 변경 작업의 종료 방지를 공유한다. 실제 종료 시 앱의 이벤트·로그·터미널 연결을 정리하며 Docker Engine·사용자 컨테이너를 중지하지 않는다. 설치 준비 모드는 트레이를 만들지 않고 기존 완료·취소 동작을 유지한다.

Tauri의 이미 잠긴 `tray-icon` 기능만 활성화했다. Cargo·npm lock 및 의존성 버전은 변경하지 않았다. 기존 고지 목록에 `tray-icon 0.25.1`이 포함돼 있음을 확인하고 Cargo 기능 설정의 입력 SHA만 갱신했다. 고지 검사는 구성 요소 555개·고지 원문 362개·소스 11개·누락 0이다.

## 실제 확인

`npm run build`, `cargo check --manifest-path src-tauri/Cargo.toml --locked --offline`, `cargo build --release --bin dockslate --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml --locked --offline`가 종료 0이다. 최초 직접 Cargo 빌드에서 앱 리소스 내장 옵션이 빠진 것을 확인해 수정했다. 그 후보는 개발 주소만 열었고 검사 통과로 기록하지 않았다. 공개 0.1.9 파일은 변경하지 않았다.

```powershell
node scripts/verify-tray.mjs .analysis/tray-native-session.json
```

자체 검증 EXE·WebView·앱 데이터 폴더의 세션만 허용한다. PID·시작 시각·EXE 경로·SHA와 Windows Shell 등록 소유권을 확인한다. 실제 후보의 X 숨김·복원, 네이티브 메뉴 6개와 설정·컨테이너·이미지 이동·실제 새로고침 IPC, 한영 전환, 미지원 언어 거부·프로세스 종료를 확인했다. [구조화 결과](tray-background.json)의 정확한 후보 SHA와 검사 범위를 기준으로 본다.

검사는 실제 Windows 트레이 알림 메시지와 네이티브 메뉴 명령을 사용했다. 마우스 좌표·Explorer 클릭 영역 검사를 대신했다고 주장하지 않는다. 작업 중 완전 종료 방지, 설치 준비 모드의 종료, 실제 로그인·재부팅·설치/제거 전체는 이번 후속 검증에서 수행하지 않았다. 엔진·컨테이너·자동 시작 등록 변경 명령은 호출하지 않았다.

0.1.9 패키지와 태그에는 이 기능이 없다. 후속 버전 변경·게시 승인 전에는 공개 파일을 덮어쓰지 않는다.
