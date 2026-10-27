# 2026-10-18 브라우징 데이터 접근 경고

- 사용자가 Advanced SystemCare의 DockSlate EXE 브라우징 데이터 접근 경고를 보고했다. 악성코드 탐지명이나 접근 대상 파일 경로는 화면에 표시되지 않았다.
- 오늘의 Privacy Shield 기록에서 해당 실행 파일의 `Browser` 분류 이벤트를 확인했다. 기록에는 접근 대상 파일명이 없어 원인을 확정할 수 없다. 보호 기록의 원문이나 다른 프로그램의 기록은 저장소에 복사하지 않았다.
- 당시 검사 대상 EXE: SHA-256 `8A566A2FC41CED72B1092F28CAE54773C92E9BBFF0DF1FE75E4AD79B6869B5BC`, 4,647,936바이트. Authenticode 상태는 `NotSigned`다. 이 값은 이후 수정 빌드의 해시가 아니다.
- 소스 검토에서 일반 Edge/Chrome 프로필의 쿠키·암호·방문 기록을 읽는 경로는 찾지 못했다. 이것은 실행 파일 전체에 대한 무해 판정이나 모든 파일 접근을 관측한 결과가 아니다.
- 로컬 Tauri 2.12.3 `src/manager/webview.rs`는 Windows WebView의 기본 데이터 경로를 앱의 local data directory로 지정한다. `src/path/desktop.rs`는 이 경로를 local data directory와 앱 식별자로 구성한다. DockSlate 식별자는 `dev.dockslate.desktop`이다. 이번 네이티브 검증은 작업 폴더 아래 별도 WebView 프로필을 사용했다.
- WebView2는 앱 전용 폴더에도 쿠키·캐시 등 브라우저 형식의 데이터를 저장한다. 이 사실만으로 이번 경고의 대상이나 원인을 확정할 수 없다. [Microsoft 문서](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder).
- Windows Defender의 해당 EXE 단일 파일 검사는 종료 코드 2 / HRESULT `0x80004005`로 실행되지 않았다. 도구 기록은 `Product/Feature disabled`다. 따라서 검사 통과 또는 악성코드 미발견으로 기록하지 않는다.
- IObit의 신뢰·예외 설정, 보안 서비스, Defender 설정은 변경하지 않았다. 이전에 탐지된 `build-records.ps1`을 복원하거나 실행하지 않았다.
- 당시 추가 EXE 실행과 기능 E2E를 중단하고 접근 대상 파일 경로와 시각을 요청했다. 소스 수정·정적 검사·컴파일은 별도로 진행했다.
- 이후 자동 승인 검토가 새 EXE 실행을 거부했다. 미해결 경고와 서명 부재를 설명한 뒤 사용자가 SHA-256 `A746B364F516DC39B05A65D47FBE727B57F27CD4D35CD068F5ABF02D149F8A02` 실행을 명시적으로 허용했다. 해당 파일만 새 작업 프로필에서 실행해 [실제 UI 경로](interaction-workflows.md)를 확인한 뒤 정상 종료했다.
- 이 승인은 안전 판정이 아니다. 경고 대상 경로는 여전히 미확인이고 보안 예외·신뢰 등록·기존 브라우저 프로필 사용은 없었다.

## 2026-10-27 제거 중 Un.exe 경고

- 사용자가 DockSlate 삭제 중 Advanced SystemCare의 미신뢰 `Un.exe` 브라우징 데이터 접근 경고를 보고했다. 화면의 실행 파일 경로는 잘렸고 접근 대상 파일은 표시되지 않았다.
- [NSIS 공식 소스](https://github.com/kichik/nsis/blob/master/Source/exehead/Main.c)는 제거 프로그램을 `%TEMP%\~nsu*.tmp\Un.exe`로 복사해 실행하는 경로를 포함한다. 삭제 시점·파일명과 부합하지만, 이번 파일의 경로·해시를 확인한 증거는 아니다.
- 초기 프로세스 조회에서는 `Un.exe`·`uninstall.exe`가 이미 종료돼 있었다. 오늘 Privacy Shield 기록 중 관련 항목만 확인해 `%LOCALAPPDATA%\DockSlate\dockslate.exe` 2건과 `%LOCALAPPDATA%\Temp\~nsu1.tmp\Un.exe` 1건의 `Browser` 분류를 확인했다. 이후 남아 있던 `Un.exe`의 제품명 `DockSlate 0.1.0`, `NotSigned`, SHA-256 `B5124F5CFDB9C4FB46EE0232270712B63FFDC0838195659E1C38247EA573E4B5`를 확인했다. 설치판에 포함된 아이콘 패치를 적용한 PE 헤더는 일치하지만 전체 제거 프로그램 본문을 대조한 결과는 아니다. 원래 경고의 접근 대상 파일은 여전히 미확인이다. 원문과 다른 프로그램의 기록은 저장소에 복사하지 않았다.
- 생성된 NSIS 제거 코드에는 사용자가 ‘앱 데이터 삭제’를 선택하고 업데이트 중이 아닐 때만 `%APPDATA%\dev.dockslate.desktop`·`%LOCALAPPDATA%\dev.dockslate.desktop`를 지우는 경로가 있다. 이 옵션의 기본 상태는 해제이며, 자체 PATH 제거 훅은 소유한 레지스트리 항목만 처리한다.
- WebView2의 앱 전용 데이터 폴더에도 쿠키·캐시 등 브라우저 형식 파일이 있다. 해당 폴더 정리 중 Access Protection 경고가 발생했을 가능성은 있으나, 실제 접근 대상과 선택한 제거 옵션은 미확인이므로 원인이나 오탐으로 확정하지 않는다. [Microsoft 데이터 폴더 설명](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder), [IObit Access Protection 설명](https://www.iobit.com/product-manuals/asc-help/).
- 추가 제거 실행·개인 브라우저 데이터 열람·보안 설정 변경·신뢰/예외 등록은 하지 않았다. 코드 서명만으로 해당 보호 경고가 사라진다고 보장하지 않는다.

## 설치·제거의 코드상 접근 범위

설치 중 경고를 제거 시 앱 데이터 정리만으로 설명할 수 없다. 다음은 현재 소스·생성된 NSIS 스크립트의 확인 결과이며, 실제 파일 접근 전체를 관측한 기록은 아니다.

| 경로·구성 요소 | 코드상 동작 |
| --- | --- |
| 설치한 앱·bin·libexec·고지, 바로가기·앱 설치 레지스트리 | 설치·제거 대상. 사용자 PATH에는 소유한 bin 항목만 추가·제거 |
| `Microsoft\EdgeUpdate\Clients`의 WebView2 런타임 등록 키 | 설치 여부 조회. 없으면 Microsoft bootstrapper를 내려받아 실행. 공용 런타임은 앱 제거 때 삭제하지 않음 |
| `%LOCALAPPDATA%\dev.dockslate.desktop` | Tauri의 기본 앱 전용 WebView2 데이터 경로. 설치 준비 창도 WebView를 생성함. 제거 시 앱 데이터 삭제 선택·업데이트 아님 조건에서만 정리 |
| `%LOCALAPPDATA%\DockSlate\WebView2-admin`, `DockSlate\cli` | 관리자 창 전용 프로필과 공식 CLI 플러그인용 프로필. 현재 NSIS의 앱 데이터 삭제 범위에는 포함되지 않음. `DockSlate` 상위 폴더 전체를 삭제하지 않음 |
| 선택한 DockSlate 전용 WSL 런타임 | 별도 대상 확인·승인 뒤 엔진 설치·시작. 앱 제거 시 WSL·VHDX·볼륨 보존 |
| 개인 Edge·Chrome의 `User Data` | 직접 쿠키·비밀번호·방문 기록을 읽거나 지우는 코드 경로는 찾지 못함. 이번 경고가 이 경로와 무관하다고 실측한 결과는 아님 |

WebView2 런타임의 공용 설치와 앱 전용 사용자 데이터는 서로 다르다. [Microsoft 배포 설명](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution). 실제 접근 대상 경로를 확보하기 전까지 앱 전용 캐시 접근·공용 구성 요소 준비·개인 브라우저 프로필 접근을 같은 것으로 취급하지 않는다.

## 실제 파일 접근 추적

[실행 결과·대상 해시](browsing-data-access-e2e.json). Microsoft 서명이 유효한 Process Monitor 4.12를 진단용으로 사용했다. 프로젝트 의존성·배포물에는 추가하지 않았다. 파일 시스템 이벤트만 포함하고 필터 밖 이벤트는 버리도록 설정한 뒤, 실제 실행 PID와 자식 WebView2 PID로 다시 한정했다. 파일 내용·레지스트리 값·네트워크 데이터는 수집하지 않았으며 원본 로그는 커밋하지 않았다. REA 도구는 연결돼 있지 않았고 Windows 내장 WPR은 실제 파일 이벤트 0건이라 통과 근거에서 제외했다.

| 실제 실행 경로 | 관측 결과 |
| --- | --- |
| 공개 설치 EXE의 첫 화면 → 취소 | 파일 이벤트 2,020건. 설치 대상 폴더 생성 없음 |
| 동봉 앱 `--installer-setup` → 취소 | 앱 447건·자식 WebView2 14,712건. 엔진 변경 승인 없음 |
| 경고에 표시된 `Un.exe`의 확인 화면 → 취소 | 572건. 격리된 대상 경로 사용, 실제 제거·앱 데이터 삭제 없음 |

총 **17,751건**, 이 중 격리된 앱 전용 WebView2 프로필에서 6,868건을 관측했다. `History`·`Network\Cookies`·`Local State`의 생성·읽기·쓰기를 확인했다. 개인 Chrome·Edge·Firefox 프로필 접근과 격리 프로필 밖의 Cookies·History 등 브라우저 파일명 접근은 이번 범위에서 **0건**이다. Windows DLL·NSIS 임시 플러그인·NVIDIA DXCache 경로의 접근도 관측됐으므로 모든 접근이 앱 폴더 안에서만 일어났다는 뜻은 아니다.

세 경로의 취소 종료 코드는 각각 2다. Process Monitor 수집 프로세스는 명시적 종료 후 1, 필터 적용 CSV 내보내기와 분석 명령은 0이다. 각 단계의 실제 파일 이벤트와 필터를 확인했으며 수집 프로세스의 종료 1을 종료 0으로 바꾸어 보고하지 않았다. 테스트 프로세스는 종료했고 전용 WSL은 중지 상태, VHDX 크기·마지막 쓰기 시각은 검사 전후 동일했다.

**한계:** 공개 설치판의 이전 앱을 검사했으며 최신 `E20E1E20…` 앱의 별도 파일 추적은 아니다. 설치 완료·엔진 시작 승인·앱 데이터 삭제·전체 제거 경로는 미검증이다. 원래 IObit 경고에는 접근 대상이 없어 이번 재현을 원래 경고의 원인 확정·무해 판정·향후 경고 해소로 취급하지 않는다. 앱 전용 브라우저 형식 데이터 접근은 확인됐지만 보호 예외·신뢰 등록·보안 설정 변경은 하지 않았다.
