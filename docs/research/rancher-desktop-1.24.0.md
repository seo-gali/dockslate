# Rancher Desktop 1.24.0 — 설치 없는 Windows 정적 분석

분석일: 2026-10-12. 공식 Windows MSI에서 Electron 패키지를 설치 없이 추출했고, REA MCP 정적 분석 결과를 확보했다. 전체 ASAR 분석은 MCP 시간 제한으로 완료 결과를 확보하지 못했다. 추출한 main·renderer entry·외부 preload의 집중 분석은 성공했으나 그래프 coverage는 **partial**이다.

Rancher Desktop 설치·실행, MSI 설치 동작, WSL 명령 실행·배포판 생성, Docker 명령·API 호출, 기존 Docker 데이터 변경은 수행하지 않았다. DockSlate 앱 구현도 이번 작업 범위에 포함하지 않았다.

## 요청별 결과

| 요청 | 결과 | 범위 |
| --- | --- | --- |
| 공식 Windows 배포 파일 확인 | 확인 | 최신 정식 v1.24.0, MSI 및 SHA-512 파일 |
| 설치 없이 app.asar 추출 | 성공 | MSI 읽기 전용 조회 → 내장 CAB → 선택 파일 추출 |
| REA MCP 정적 분석 | 부분 성공 | 배포 코드 3개와 package.json 집중 분석; 전체 ASAR 완료 결과 미확보 |
| Electron·IPC·Docker·WSL 구조 | 부분 확인 | REA 관찰, 배포 바이트 보조 조사, 같은 버전 공개 소스 교차 확인 |
| 근거·미확인 구분 기록 | 완료 | 이 문서와 아래 두 JSON에 기록 |

## 배포 파일과 추출 경로

[공식 릴리스](https://github.com/rancher-sandbox/rancher-desktop/releases/tag/v1.24.0), [공식 자산 목록](https://github.com/rancher-sandbox/rancher-desktop/releases/expanded_assets/v1.24.0), [Releases API](https://api.github.com/repos/rancher-sandbox/rancher-desktop/releases/latest)를 확인했다. 조회 시 최신 정식 릴리스는 v1.24.0이며 공개 시각은 2026-07-29T21:34:21Z이다. 해당 릴리스의 Windows 자산은 `Rancher.Desktop.Setup.1.24.0.msi`와 그 `.sha512sum`이다. Windows ZIP/portable 자산은 이 릴리스 목록에 없었다.

| 항목 | 확인값 |
| --- | --- |
| MSI 크기 | 670,932,992 bytes |
| MSI SHA-256 | `5fc4e795a1c3bf72a2dac9144d55daab181f30d1a3049d96a4c025985769960b` |
| MSI SHA-512 | `6428f330cdf8dc9dbbc07bbde270046c9e86fb91e90392c0d25ac764e64eaa8f9d2b3e7faaffed669a48f7fd7445dadda18072dd51c905bf59df4787b70ed77e` |
| MSI 메타데이터 | ProductName=Rancher Desktop, ProductVersion=1.24.0, Manufacturer=SUSE |
| ASAR 크기 | 56,844,552 bytes |
| ASAR SHA-256 | `385a8ec31fb1a44e022670ef56e44cba60450e1c711cb8e22a62c3d00a071d5d` |
| 외부 preload 크기 | 12,219 bytes |
| 외부 preload SHA-256 | `9ca9db5c4eeb24caba95287b5bf5cc3303ab7f03cdcd9b6dfe8fe04bf4c1e728` |

다운로드 원본은 [공식 Windows MSI](https://github.com/rancher-sandbox/rancher-desktop/releases/download/v1.24.0/Rancher.Desktop.Setup.1.24.0.msi)이다. 다운로드 후 SHA-256을 GitHub asset digest와, SHA-512를 공식 체크섬 파일과 비교해 일치를 확인했다.

작업 폴더는 `.analysis/rancher-desktop/v1.24.0/`이다. 대용량 배포 파일과 추출 원본은 `.gitignore`에서 제외하고 로컬에 보존했다.

| MSI 안의 파일 | MSI 매핑 | 실제 조사 경로 |
| --- | --- | --- |
| `resources/app.asar` | `#cab7.cab`, sequence 150, file ID `f_wgee3DDgNpzMdUmhYo7zzDVHSko5bYjNK4J6vymhmew` | `payload-static/resources/app.asar` |
| `resources/resources/preload.js` | `#cab3.cab`, sequence 89, file ID `f_lGRGCkBmJlnzKtEkdMpwHBTnY1T8Ar3bBWOzfEIwCGk` | `payload-static/resources/resources/preload.js` |
| `resources/app.asar.unpacked/` | Directory/Component/File/Media 테이블로 복원 | `payload-static/resources/app.asar.unpacked/` |
| ASAR 내부 main | `package.json`의 main=`dist/app/background.js` | `asar-members/dist/app/background.js` |
| ASAR 내부 renderer entry | `dist/app/js/index.1a2f9a7b.js` | `asar-members/dist/app/js/index.1a2f9a7b.js` |

Windows의 `msi.dll`에 `MsiOpenDatabaseW(..., MSIDBOPEN_READONLY)`로 접근했다. File/Directory/Component/Media/Property 테이블을 조회하고 `_Streams`의 내장 CAB 10개를 복사했다. Windows `expand.exe -F:<File ID>`로 선택 파일만 풀었다. `msiexec`, custom action, 설치된 앱의 코드는 실행하지 않았다.

ASAR 헤더를 정적으로 읽은 결과 파일 항목 5,754개, JavaScript 3,359개, 외부 unpacked 항목 77개를 확인했다. ASAR 안의 5,677개 파일은 헤더의 전체 SHA-256과 블록 SHA-256을 모두 검증했다. `node_modules/` 밖의 JavaScript는 31개이며 그 범위에는 `.map` 파일이 없었다. 전체 패키지의 모든 JavaScript를 분석했다는 의미는 아니다.

## REA MCP로 확보한 근거

연결된 서버는 `rea-agents 6.4.0` / REA MCP 6.4.0이다. REA JavaScript 분석은 앱 코드를 실행하지 않고 구문을 읽는다. 이번에는 네이티브 분석 세션을 열지 않았다.

집중 입력 `first-party-static/`에는 ASAR에서 그대로 복사한 `package.json`, main, renderer entry와 MSI에서 그대로 추출한 `preload.js`만 넣었다. 각 코드의 SHA-256은 추출 원본과 같다. 이 분석 디렉터리의 digest는 `8033ef7ee85fe1c4ebb77f01ecb9198f1497d8d8b17a0dcf9716d176209fd57c`이며 ASAR 자체의 digest와 구분한다. 의존성 코드와 나머지 chunk는 집중 입력에 포함하지 않았다.

| 근거 | 도구 | Evidence ID |
| --- | --- | --- |
| 집중 분석 parent | `analyze_javascript_application` | `ev_07e0d57c7fe997b308b28a4f6e67cda7f96067ee3dd8079391c50c8733bf8c0b` |
| 분석 summary | 위 도구의 `detail: summary` | `ev_7067b44619d11d2668241796235fdfc7a64f54ee81fa6d2098c99f23ce662e7d` |
| main source module | `inspect_analysis_view` | `ev_88c1d1776737656e35df1872c847882c546315fcf2e330e320a743d6658a0a54` |
| preload source module | `inspect_analysis_view` | `ev_c8ea1d34d712c450b60e14d1a72d6407fd07f5ccc78d95b2c0f1822378aaaaad` |
| preload IPC 관계 | `trace_application_feature` | `ev_7702c6cf80a4d5e3d898605565b0b4456babf752fc7d1456ac1f19c183126357` |

위 4개 summary/view/trace 원본 레코드는 [선택 REA Evidence](rancher-desktop-1.24.0.evidence.json)에 보존했다. parent 전체 그래프를 내보낸 bundle은 아니다. view의 `complete-within-view`나 개별 AST 관찰의 `complete`는 parent 분석 전체의 완전성을 뜻하지 않는다.

실제 분석값은 관련 파일 4개, 파싱한 JavaScript 3개, 1,612,573 text bytes, 방문 AST node 280,462개, findings 135개, parse failure 0개이다. main은 ESM source module이며 REA는 import 관계 35개를 관찰했다. preload는 CommonJS source module로 분류했다. 통계의 `modules: 0`을 번들 모듈을 전부 복원했다는 값으로 해석하지 않았다.

REA가 직접 관찰한 IPC는 **외부 preload의 renderer 측 호출**이다. 13개 연산, literal channel 10개, transmission 10개, listener 3개이며 자동으로 연결된 main handler는 0개다.

| 채널 | 관찰된 연산 |
| --- | --- |
| `extensions/spawn/kill` | send 2개 |
| `extensions/spawn/streaming` | send |
| `extensions/spawn/blocking` | invoke |
| `extensions/spawn/output` | on |
| `extensions/spawn/error` | on |
| `extensions/spawn/close` | on |
| `extensions/ui/show-open` | invoke |
| `extensions/ui/toast` | send 3개 |
| `extensions/vm/http-fetch` | invoke |
| `extensions/open-external` | send |

각 IPC 관찰에는 `preload.js`의 line/column 위치가 있다. registration 실행, sender 검증, main counterpart, 권한 집행을 확인한 것은 아니다. BrowserWindow/contextBridge 관찰 0개도 그 API가 없다는 근거로 사용하지 않았다.

## 배포 바이트 보조 조사와 공개 소스 교차 확인

아래는 REA 자동 그래프가 확정하지 못한 부분을 추출 코드의 실제 구문으로 확인한 결과다. 보조 조사에서 앱 코드를 실행하거나 재작성하지 않았다. [배포 근거 JSON](rancher-desktop-1.24.0.artifacts.json)에 파일 SHA-256, UTF-16 offset, 0부터 시작하는 column, 짧은 원문 구문을 기록했다. GitHub 소스는 모두 `v1.24.0`으로 고정했다. 소스와 전체 배포물을 재현 빌드로 동일성 검증한 것은 아니다.

| 구조 | 배포 코드의 근거 | 같은 버전 공개 소스 |
| --- | --- | --- |
| main UI | `main-window` offset 384425: `nodeIntegration: true`, `contextIsolation: false` | [window/index.ts openMain](https://github.com/rancher-sandbox/rancher-desktop/blob/v1.24.0/pkg/rancher-desktop/window/index.ts#L107) |
| extension UI | `extension-window` offset 386315: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`; `preload-registration`에서 외부 preload 등록 | [window/index.ts createView](https://github.com/rancher-sandbox/rancher-desktop/blob/v1.24.0/pkg/rancher-desktop/window/index.ts#L196) |
| extension API | 외부 preload offset 11508: `x-rd-extension:` 분기에서 `contextBridge.exposeInMainWorld("ddClient", …)` | [preload 빌드 경로](https://github.com/rancher-sandbox/rancher-desktop/blob/v1.24.0/scripts/lib/build-utils.ts#L335) |
| main IPC | `settings-read` reply/sync return, `settings-write` handler와 `settings-update` 응답, `k8s-current-engine` 이벤트 구문 | [background.ts](https://github.com/rancher-sandbox/rancher-desktop/blob/v1.24.0/background.ts#L656) |
| 엔진 선택 | `docker-endpoint`의 Windows engine switch에서 containerd와 Moby를 분리; MOBY 분기에서 `npipe:////./pipe/docker_engine`로 client 생성 | [WSLBackend: NerdctlClient / MobyClient](https://github.com/rancher-sandbox/rancher-desktop/blob/v1.24.0/pkg/rancher-desktop/backend/wsl.ts#L1362) |
| Docker CLI | `docker-cli-env` offset 520020: 번들 CLI 실행 옵션의 `DOCKER_HOST`를 client endpoint로 설정 | [MobyClient.runClient](https://github.com/rancher-sandbox/rancher-desktop/blob/v1.24.0/pkg/rancher-desktop/backend/containerClient/mobyClient.ts#L453) |
| Windows proxy | `windows-proxy` offset 324730: `wsl-helper`에 `docker-proxy serve` 인수를 전달하는 spawn 구문 | [WindowsIntegrationManager](https://github.com/rancher-sandbox/rancher-desktop/blob/v1.24.0/pkg/rancher-desktop/integrations/windowsIntegrationManager.ts#L343) |
| Docker context | `docker-context` offset 204149: default socket 소유 시 default 선택 규칙, Windows에서 그 조건을 요구하는 guard | [DockerDirManager](https://github.com/rancher-sandbox/rancher-desktop/blob/v1.24.0/pkg/rancher-desktop/utils/dockerDirManager.ts#L136) |
| WSL 배포판 | `wsl-distros` offset 614723: `rancher-desktop`, `rancher-desktop-data`; `wsl-data-directories`: `/etc/rancher`, `/var/lib` | [WSLBackend](https://github.com/rancher-sandbox/rancher-desktop/blob/v1.24.0/pkg/rancher-desktop/backend/wsl.ts#L67) |
| WSL 호출 | `wsl-import`: 배포판 미등록 시 `--import … --version 2`; `wsl-exec`: `wsl.exe` spawn 구문 | [ensureDistroRegistered](https://github.com/rancher-sandbox/rancher-desktop/blob/v1.24.0/pkg/rancher-desktop/backend/wsl.ts#L461), [execWSL](https://github.com/rancher-sandbox/rancher-desktop/blob/v1.24.0/pkg/rancher-desktop/backend/wsl.ts#L787) |

공개 소스에서 추가로 확인한 시작 경로는 `startBackend()` → `startK8sManager()` → backend `start(cfg)`이며 container engine client를 extension manager 등에 주입한다. [background.ts 시작 경로](https://github.com/rancher-sandbox/rancher-desktop/blob/v1.24.0/background.ts#L511)

따라서 정적 근거로 확인한 구조는 Electron main이 Windows WSL backend 및 엔진 client를 관리하고, Moby client가 Windows Docker named pipe endpoint를 사용하며, WSL integration의 helper proxy가 별도로 존재하는 구조다. main UI와 extension UI의 통신 경계를 동일하게 취급할 수 없다. containerd를 Docker Engine으로 취급할 수도 없다. Windows에 named `rancher-desktop` context가 항상 존재한다고 가정할 근거도 없다. 실제 실행 순서와 proxy 내부의 pipe→WSL socket 전달은 검증하지 않았다.

`app.asar.unpacked`에는 `native-reg`의 Windows arm64/ia32/x64 addon 3개와 `posix-node`의 Linux/macOS addon 4개가 포함되어 있다. 파일 존재와 MSI 매핑을 확인했으며 native export, registry 호출, 실행 시 선택되는 addon을 역어셈블하거나 관찰하지 않았다.

## 한계와 미확인 사항

- 전체 ASAR의 `analyze_javascript_application` 호출은 MCP client의 `300s` timeout을 반환했다. 이후 해당 ASAR SHA-256으로 조회한 Evidence summary에 parent 레코드가 없었다. 전체 분석 성공이나 전체 코드 coverage를 주장하지 않는다.
- 집중 분석의 application/semantic coverage는 모두 `partial`이다. semantic graph의 node ceiling은 100,000이며 renderer의 의미 그래프가 parent result budget을 초과했다. 해당 파일의 static/module facts는 보존되었지만 완전한 의미 그래프는 확보하지 못했다.
- minified alias와 IPC proxy wrapper의 main handler를 REA가 자동 연결하지 못했다. `settings-read` channel trace는 no-match였다. 배포 구문에 해당 handler가 있으므로 no-match를 기능 부재로 해석하지 않았다.
- `recover_javascript_sources`는 Wakaru provider 미설정으로 `capability_unavailable`이었다. 안내된 provider는 Linux x64이며 추가 도구나 의존성을 설치하지 않았다.
- named pipe literal의 의미 trace는 10 MiB MCP transport budget을 초과했다. 완료 원본을 검사하지 않았으며 이 trace를 연결 경로 확정 근거로 사용하지 않았다. 관계를 좁힌 조회도 partial/no seed였으므로 부재를 증명하지 않는다.
- 실제 pipe 소유자, Docker context/엔진 상태, API 연결, WSL 배포판 등록 여부, VHDX 경로·소유자·크기·잠금 상태는 조사하지 않았다. 정적 배포판 이름을 현재 시스템 상태로 간주하지 않는다.
- main IPC sender 검증, extension API 권한 집행, 동적 채널, 네이티브 helper 내부 구현, 실제 UI 동작과 데이터 변경은 미검증이다.
- DockSlate 독자 설계나 MVP 기능 구현 결과는 없다. 이 문서는 후속 구현의 정적 참고 근거다.

## 라이선스와 고지

ASAR의 `package.json`에서 Apache-2.0을 확인했고, 같은 버전의 [루트 LICENSE](https://github.com/rancher-sandbox/rancher-desktop/blob/v1.24.0/LICENSE)도 확인했다. 공개 packaging 설정의 저작권 고지는 `2021–2026 SUSE LLC`이다. [packaging 설정](https://github.com/rancher-sandbox/rancher-desktop/blob/v1.24.0/packaging/electron-builder.yml#L1)

MSI의 `LICENSE.electron.txt`와 `LICENSES.chromium.html`, ASAR 내부 dependency별 LICENSE/NOTICE, `background.js.LICENSE.txt`를 추출해 보존했다. Electron 고지는 MIT 허가 문구와 Electron contributors/GitHub 저작권을 포함하며 background의 고지에는 fromCodePoint와 js-yaml MIT attribution이 있다. Chromium 전체 목록과 모든 번들 dependency의 라이선스 조건을 감사한 것은 아니다. Rancher Desktop 루트 라이선스를 모든 번들 구성요소의 라이선스로 확대 적용하지 않는다. 원본 코드·배포 파일은 변경하지 않았다.

## 실제 수행과 검증

읽기 전용 MSI 도구 [read-msi.ps1](../../scripts/research/read-msi.ps1), 선택 추출 도구 [extract-msi-files.ps1](../../scripts/research/extract-msi-files.ps1), 정적 ASAR 도구 [read-asar.mjs](../../scripts/research/read-asar.mjs)를 사용했다. 신규 패키지 의존성이나 lock 변경은 없다.

```powershell
$base = Join-Path (Get-Location).Path '.analysis\rancher-desktop\v1.24.0'
$msi = Join-Path $base 'Rancher.Desktop.Setup.1.24.0.msi'
Get-FileHash -LiteralPath $msi -Algorithm SHA256
Get-FileHash -LiteralPath $msi -Algorithm SHA512
.\scripts\research\read-msi.ps1 -MsiPath $msi -OutputDirectory (Join-Path $base 'msi-readonly')
.\scripts\research\extract-msi-files.ps1 -InventoryDirectory (Join-Path $base 'msi-readonly') -OutputDirectory (Join-Path $base 'payload-verified')
node .\scripts\research\read-asar.mjs (Join-Path $base 'payload-static\resources\app.asar') (Join-Path $base 'asar-members')
```

추출 도구는 새 출력 디렉터리를 요구하므로 재실행 시에는 다른 이름을 지정한다.

최종 선택 추출 81개 파일의 크기·SHA-256을 검증했고, 집중 입력 4개가 추출 원본과 일치함을 확인했다. 최종 ASAR 도구를 `payload-verified/resources/app.asar`와 새 출력 `asar-members-verified/`로 다시 실행해 내부 무결성 검사를 통과했다. 원본 MSI의 SHA-256도 유지되었다. 배포 코드 근거 15개의 파일 해시·원문 위치와 문서의 로컬 링크 6개를 확인했다.

`node --check scripts/research/read-asar.mjs`, PowerShell AST parser를 통한 두 `.ps1` 파일의 구문 검사, `git diff --check`가 통과했다. 검증 요약은 로컬 `.analysis/rancher-desktop/v1.24.0/verification.json`에 보존했다. 앱 실행·Docker/WSL E2E 검증은 수행하지 않았다.

REA MCP에 실제 전달한 핵심 인수:

```json
{
  "input_path": "D:\\01_Programming\\08_AI\\REA\\dockslate\\.analysis\\rancher-desktop\\v1.24.0\\first-party-static",
  "format": "directory",
  "detail": "summary",
  "max_heap_mb": 2048,
  "analysis_timeout_ms": 60000
}
```

이후 동일 parent Evidence로 module page/item view를 조회했고, `seed: {"kind":"module","value":"preload.js","match":"exact"}`, `direction: "outgoing"`으로 preload IPC 관계를 추적했다. 설치나 runtime 실행을 요구하는 분석은 수행하지 않았다.
