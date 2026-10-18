# 2026-10-18 브라우징 데이터 접근 경고

- 사용자가 Advanced SystemCare의 DockSlate EXE 브라우징 데이터 접근 경고를 보고했다. 악성코드 탐지명이나 접근 대상 파일 경로는 화면에 표시되지 않았다.
- 오늘의 Privacy Shield 기록에서 해당 실행 파일의 `Browser` 분류 이벤트를 확인했다. 기록에는 접근 대상 파일명이 없어 원인을 확정할 수 없다. 보호 기록의 원문이나 다른 프로그램의 기록은 저장소에 복사하지 않았다.
- 당시 검사 대상 EXE: SHA-256 `8A566A2FC41CED72B1092F28CAE54773C92E9BBFF0DF1FE75E4AD79B6869B5BC`, 4,647,936바이트. Authenticode 상태는 `NotSigned`다. 이 값은 이후 수정 빌드의 해시가 아니다.
- 소스 검토에서 일반 Edge/Chrome 프로필의 쿠키·암호·방문 기록을 읽는 경로는 찾지 못했다. 이것은 실행 파일 전체에 대한 무해 판정이나 모든 파일 접근을 관측한 결과가 아니다.
- 로컬 Tauri 2.12.3 `src/manager/webview.rs`는 Windows WebView의 기본 데이터 경로를 앱의 local data directory로 지정한다. `src/path/desktop.rs`는 이 경로를 local data directory와 앱 식별자로 구성한다. DockSlate 식별자는 `dev.dockslate.desktop`이다. 이번 네이티브 검증은 작업 폴더 아래 별도 WebView 프로필을 사용했다.
- WebView2는 앱 전용 폴더에도 쿠키·캐시 등 브라우저 형식의 데이터를 저장한다. 이 사실만으로 이번 경고의 대상이나 원인을 확정할 수 없다. [Microsoft 문서](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder).
- Windows Defender의 해당 EXE 단일 파일 검사는 종료 코드 2 / HRESULT `0x80004005`로 실행되지 않았다. 도구 기록은 `Product/Feature disabled`다. 따라서 검사 통과 또는 악성코드 미발견으로 기록하지 않는다.
- IObit의 신뢰·예외 설정, 보안 서비스, Defender 설정은 변경하지 않았다. 이전에 탐지된 `build-records.ps1`을 복원하거나 실행하지 않았다.
- 추가 EXE 실행과 기능 E2E는 중단했다. 사용자에게 이번 이벤트의 접근 대상 파일 경로와 시각을 요청했으며, 이를 확인하기 전에는 앱을 자동으로 다시 실행하지 않는다. 소스 수정·정적 검사·컴파일은 별도로 진행한다.
