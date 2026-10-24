# 라이선스 자료

`inventory.json`은 구성 요소와 원문·소스 파일을 연결합니다. `texts`의 파일명은 원문 SHA-256이며 원래 파일명은 각 구성 요소의 `texts[].name`에 남아 있습니다. 저작권·보증 부인·특허·NOTICE 내용을 수정하지 않았습니다.

## 범위

- Cargo: 잠금 파일과 Windows normal/build 그래프를 대조한 242개. 빌드 전용 코드까지 보수적으로 포함합니다.
- npm: 실제 설치된 24개. 실행용 React·Tauri API·scheduler와 빌드 도구를 구분합니다. 플랫폼 빌드 패키지는 같은 버전의 공식 본체 원문을 연결합니다.
- Go: CLI·Buildx의 공식 버전 vendor 자료와 Compose의 내장 모듈 목록을 대조한 276개 버전. 추가 확보한 모듈 ZIP 30개는 upstream go.sum·바이너리의 h1 값과 대조했습니다.
- 별도 문서: Go 표준 라이브러리, Rust 표준 라이브러리, WebView2 SDK, NSIS와 보조 DLL.
- 외부 다운로드: 설치 시 직접 내려받는 Linux 패키지 5개. 이 자료에 해당 Linux 실행 파일을 재배포하지 않습니다.

## 원문 출처

Cargo·npm은 설치된 공식 패키지의 원문을 사용합니다. alloc-stdlib·defmt-parser·webview2-com 계열의 누락 원문은 각 `.cargo_vcs_info.json`에 기록된 정확한 upstream 커밋에서 확보했습니다. selectors는 해당 패키지의 MPL-2.0 선언과 소스 헤더를 확인해 Mozilla의 공식 MPL-2.0 원문을 포함했습니다.

Go CLI v29.8.2는 upstream 커밋 `7fc2dff9bceb96b266a3b2c3117c0955a0d9e616`, Buildx v0.38.0은 `0dbe87f36ed472fe36b6796c3f70b4210a731fc5`의 공개 자료를 사용합니다. 엔진 고지는 실제 Linux 바이너리의 빌드 커밋 `8af9fe3a36bab3e039862a2ab1cef1880c9b4d03`과 대조했습니다.

WebView2 SDK는 Microsoft 공식 NuGet 1.0.3800.47의 원문이며 정적 로더의 해시 일치를 확인했습니다. NSIS는 3.11의 COPYING, 보조 DLL은 nsis_tauri_utils-v0.5.3의 LICENSE와 manifest 조건에 해당하는 의존성 원문을 포함합니다. 보조 DLL 소스에는 upstream Cargo.lock이 없으며 정확한 빌드 의존성 버전을 새로 추정하지 않습니다.

## 소스 이용

`sources`의 Rust `.crate`, Go `.zip`, NSIS `.tar.gz` 파일은 원본 소스 아카이브입니다. 재압축하거나 소스 파일을 수정하지 않았습니다. Rust는 Cargo.lock의 SHA-256, Go는 모듈 h1과 아카이브 SHA-256을 확인했습니다. URL·크기·체크섬은 `inventory.json`의 `sources`에 있습니다.

MPL 대상 Rust 5개·Go 4개와 NSIS 본체·보조 DLL 소스 2개를 제공합니다. 개별 라이선스와 저작권 고지를 유지해 사용하세요. NSIS LZMA의 CPL linking exception은 DockSlate의 별도 코드에 CPL을 일괄 적용하는 조건이 아닙니다.

고지 변경 검증은 `node scripts/verify-license-inventory.mjs`로 실행합니다. 의존성이나 공식 바이너리가 바뀌면 원문·소스·목록을 다시 대조한 뒤 패키징합니다.
