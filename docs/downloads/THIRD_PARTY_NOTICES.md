# 타사 라이선스·저작권 고지

DockSlate 0.1.5 · Windows x64

Moby 기반 Docker Engine은 [Apache-2.0](https://github.com/moby/moby/blob/8af9fe3a36bab3e039862a2ab1cef1880c9b4d03/LICENSE) 오픈소스로 엔진 사용료가 없습니다. Docker Desktop 구독은 필요하지 않습니다. 각 의존성·Docker Hub·컨테이너 이미지·외부 서비스에는 별도 조건이 적용됩니다. 이 고지가 DockSlate 자체 코드나 모든 구성 요소에 Apache-2.0을 부여하는 것은 아닙니다.

## 고지와 소스

설치 폴더와 포터블 ZIP의 `licenses` 폴더에 다음 파일을 포함합니다.

| 파일 | 내용 |
| --- | --- |
| `inventory.json` | 구성 요소별 버전·조건·고지 파일·체크섬 |
| `texts/` | upstream의 LICENSE·NOTICE·저작권 원문. 동일한 원문만 SHA-256으로 통합 |
| `sources/` | MPL 대상 Rust·Go 의존성과 NSIS의 버전별 원본 소스 |
| `README.md` | 범위·원문 출처·소스 이용 안내 |

**[고지·소스 전체 ZIP 다운로드](https://seo-gali.github.io/dockslate/downloads/DockSlate-0.1.5-third-party-licenses.zip)**

저작권자와 개별 조건은 각 원문에 유지했습니다. 라이선스 표현의 OR·AND를 일괄 변환하거나 별도 권한을 부여하지 않습니다. MPL 구성 요소는 수정하지 않은 원본 소스를 함께 제공하며 각 원본의 고지와 조건을 유지합니다. NSIS LZMA의 CPL과 linking exception도 원문과 소스에 포함합니다.

이전 0.1.4 설치판·포터블에 포함한 고지 표지는 0.1.3 의존성 스냅샷입니다. 구성 요소 버전·조건은 동일하며, 해당 문서의 [0.1.3 고지 ZIP 링크](https://seo-gali.github.io/dockslate/downloads/DockSlate-0.1.3-third-party-licenses.zip)를 계속 제공합니다.

## 검토 범위

- Windows normal/build Rust 그래프 242개, 설치된 npm 패키지 24개, Windows CLI·플러그인의 Go 모듈 276개를 기록했습니다. 빌드 전용·보수적으로 포함한 vendor 집합은 실제 앱 실행 의존성과 구분합니다.
- Go 표준 라이브러리, Rust 표준 라이브러리의 전체 저작권 문서, WebView2 정적 로더, NSIS와 보조 DLL의 고지도 포함합니다.
- WebView2 1.0.3800.47의 정적 로더는 공식 NuGet SDK와 SHA-256이 일치합니다. NSIS 보조 DLL은 공개 manifest의 의존성 조건과 고지를 검토했으며 upstream은 해당 소스에 Cargo.lock을 제공하지 않습니다.
- 원문 362개와 소스 아카이브 11개를 파일 해시로 연결했습니다. 잠금 파일·대상 코드·공식 CLI 파일이 달라지면 패키징 검증을 중단합니다.

## Linux 런타임

Ubuntu WSL 이미지와 Linux 엔진 패키지는 설치 시 Canonical·Docker의 공식 서버에서 직접 내려받습니다. Windows EXE·ZIP에 Linux 바이너리를 포함하지 않습니다. Ubuntu·WSL 구성 요소 전체에 Apache-2.0이 적용되는 것은 아닙니다. [Canonical 정책](https://canonical.com/legal/intellectual-property-policy)과 각 패키지 조건을 따릅니다.

설치 대상 Docker 패키지 5개는 고정된 SHA-256과 실제 배포 문서를 대조해 별도 기록했습니다. 모든 패키지에 `/usr/share/doc/<패키지>/copyright`가 있는 것은 아닙니다. 누락된 문서는 해당 버전의 upstream LICENSE·NOTICE로 연결했으며, Ubuntu 패키지의 고지와 소스 정보는 각 패키지 및 공식 저장소에서 제공합니다.

[검증 기록](https://github.com/seo-gali/dockslate/blob/main/docs/results/license-delivery.json)
