# 0.1.16 설치 화면 수정

0.1.15의 개발 서버 연결 거부를 수정한다. 화면을 EXE에 내장하고 잘못된 release 빌드를 컴파일 단계에서 거부한다. 읽기 전용 검사에 내장 화면 검증을 추가했다. WebView2 런타임을 유지하며 Edge 브라우저를 추가하지 않는다.

[오류 재현·소스 검증](embedded-frontend-20261127.json) · [제작·검사 기록](release-0.1.16.json).

설치 EXE·포터블 ZIP·고지 ZIP을 제작했고, ZIP 435개·고지 410개 파일을 확인했다. 포터블과 설치 내부의 원본 파일 432개·PATH 도우미·앱 제품 버전을 대조했다. 줄바꿈과 도구 manifest 표현 차이는 기록했다.

개발 서버가 없는 상태에서 포터블과 설치 파일 내부 앱의 실제 설치 화면을 각각 열었다. 두 화면 모두 내장 JS·CSS 응답 200, renderer 예외 0, 설치 모드와 엔진 변경 명령 미호출을 확인했다. 포터블 읽기 전용 검사에서도 `frontendEmbedded: true`를 확인했다. 소스 Node 33개·Rust 38개와 CLI 6개 검사를 통과했고 GitHub 소스·Windows CI와 일회성 포장은 성공했다.

사용자는 새 파일 4개의 VirusTotal 공개 업로드를 승인했다. 웹 업로드가 HTTP 429·`RecaptchaRequiredError`로 거부됐고 사용자도 이미지 인증 실패를 보고했다. 완료된 새 검사 결과는 아직 확인하지 못했으며 [진행 기록](virustotal-0.1.16.json)에 구분했다. 공개 Release·홈페이지는 아직 0.1.15다. 미서명 개발판이며 전체 설치·제거·부팅은 미검증이다.

약 56MB·435개 파일인 ZIP에 표시되는 3MB·단일 파일 안내는 압축 내부 검사 범위 제한이다. ZIP 자체 업로드를 허용한다는 화면 안내와 reCAPTCHA 거부를 구분한다. 앱·CLI는 별도 실행 파일로 검사하도록 승인·준비했다.

| 파일 | bytes | SHA-256 |
| --- | --- | --- |
| DockSlate_0.1.16_x64-setup.exe | 41207253 | `C6C4CC47005788237333BF0F70E44DE6095F781C5CDFAD0D7072C75420FCD821` |
| DockSlate-0.1.16-windows-x64.zip | 56243692 | `6B43B2E306B645F8CB7CD5A29763B1A5B55A3CD24AD652EE3E1D2B95E3F9A79A` |
| DockSlate-0.1.16-third-party-licenses.zip | 5269085 | `C62B6FB6EFDCED562260AC00D80DD7609ABD2C23AD305EC0E42E0C5EA023FE8A` |
