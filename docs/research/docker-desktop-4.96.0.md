# Docker Desktop 4.96.0 설치 원본 정적 조사

조사일: 2026-10-20. 범위는 배포 파일의 구성 확인이며 설치·실행 동작 검증은 아니다.

## 대상과 도구

- 원본: `.analysis/docker-desktop/4.96.0/Docker Desktop Installer.exe`
- 원본 SHA-256: `3F75D46A07FF7C7ADCC42E55B2BAB862E25A459351723AC2633DE9AD22A5B4B6`
- 원본 REA `inspect_artifact` Evidence: `ev_1802303956373ff7cfd3f1cbc5f61b325b534302944d19523ddbec114b723edf`
- 기존 도구: `node C:\Users\user\AppData\Local\npm-cache\_npx\af752b90495482d7\node_modules\rea-agents\scripts\rea.mjs`, Windows 기본 `tar.exe`, PowerShell/.NET 읽기 전용 스트림.
- 설치 원본과 추출 실행 파일은 실행하지 않았다. WSL·엔진·보안 설정·사용자 Docker 설정·credentials는 읽거나 변경하지 않았다. 신규 도구·의존성은 설치하지 않았다.

## 원본에서 파생한 리소스

`resource-inventory.ps1`의 PE resource tree 결과를 사용했다. 아래 offset은 원본 파일 시작 기준이며 length는 복사한 바이트 수다. 리소스를 새 `derived-resources/*.resource`로 복사했고 원본·Evidence·범위·파생 SHA-256을 [로컬 manifest](../../.analysis/docker-desktop/4.96.0/derived-resources/manifest.json)에 보존했다. 이 추출·해시는 일반 PowerShell 관찰이며 REA Evidence로 표현하지 않는다.

| 원본 resource | Offset | Length | 형식 | 파생 SHA-256 |
| --- | ---: | ---: | --- | --- |
| `/10/DOCKERDESKTOP/0` | 16875768 | 352773917 | 7z | `333A0BEAAA3A52CD5B8CCAA76823CDC65D9F2579242963FDD7D72AC7D7078C25` |
| `/10/DOCKERDESKTOPVM/0` | 369649688 | 275317653 | 7z | `327E9226CC2EDA5AF6892B88F600596B6B25D032260D17C7FC9BD9761B43BB39` |
| `/10/LAUNCHER/0` | 644967344 | 5527802 | gzip | `41EBE785F8C75DC134FCE8045C93D1D753FD4FB99F13CD25687DFF3A584EBA0D` |
| `/10/7ZIP/0` | 16415556 | 460210 | gzip | `FF44A183C3293BB27A3F7C1D537ECB44FE644B28652CE79BF4C569CD886CC0E8` |

형식은 각 파일의 magic bytes와 `tar` 인벤토리로 확인했다. LAUNCHER·7ZIP gzip의 내부 파일은 이번에 풀거나 실행하지 않았다.

## 배포 구성 관찰

`tar.exe -tf`가 DOCKERDESKTOP 197개, DOCKERDESKTOPVM 2개 멤버를 열거했다. 아래는 실제 archive member이며 설치 후 경로·사용 여부를 관찰한 것은 아니다.

| 리소스 | 실제 멤버 | 보관 멤버 크기(bytes) |
| --- | --- | ---: |
| DOCKERDESKTOP | `resources/bin/docker.exe` | 44921264 |
| DOCKERDESKTOP | `resources/cli-plugins/docker-compose.exe` | 33362864 |
| DOCKERDESKTOP | `resources/cli-plugins/docker-buildx.exe` | 70036912 |
| DOCKERDESKTOP | `resources/com.docker.backend.exe` | 155998640 |
| DOCKERDESKTOP | `resources/componentsVersion.json` | 555 |
| DOCKERDESKTOP | `resources/wsl/ext4.vhdx` | 100663296 |
| DOCKERDESKTOP | `resources/wsl/wsl-data.tar` | 3939328 |
| DOCKERDESKTOPVM | `resources/docker-desktop.iso` | 786743296 |
| DOCKERDESKTOPVM | `resources/wsl/docker-wsl-cli.iso` | 812777472 |

따라서 이 설치 원본은 Windows CLI·Windows Compose/Buildx·별도 Windows backend와 WSL용 VHDX/tar/ISO 파일을 함께 배포한다. VHDX·ISO는 추출·마운트하지 않았다. `wsl-data.tar`의 `tar -tf` 결과는 11개 멤버이며 `dev/`, `etc/`, `mnt/`, `proc/`, `sys/`와 `wsl-keepalive` 등을 포함한다. keepalive 내용·실행 동작은 분석하지 않았다.

추출한 `componentsVersion.json`은 `appVersion=4.96.0`, `buildNumber=243774`, `dockerCLIVersion=29.9.1`, `engineVersion=29.9.1`, `buildxVersion=v0.38.0`, `composeVersion=v5.6.0`을 선언한다. 이는 배포 manifest의 선언이며 각 실행 파일을 실행하여 얻은 버전은 아니다.

인벤토리와 선택 멤버의 부모·크기·SHA-256은 `.analysis/docker-desktop/4.96.0/derived-resources/`의 `*.tar-inventory.txt`, `selected-members.manifest.json`에 저장했다.

## 실제 REA 결과와 제한

선택 멤버를 `tar -xf`로 새 `selected-members/`에 추출한 뒤 각 실행 파일에 실제 REA `inspect-artifact ... --json`을 호출했다. 아래 네 호출의 종료 코드는 모두 0이며 PE 형식과 digest를 확인했다.

| 대상 | REA Evidence |
| --- | --- |
| Windows `docker.exe` | `ev_851946dd3ea2fa1e5d20f0fb84f4417ace65f975904c0189900bb593052c52ea` |
| Windows `docker-compose.exe` | `ev_7000bfb11e5c9f15bd365865f4dff6756782ec69c2b37a18f63c170db39fad47` |
| Windows `docker-buildx.exe` | `ev_738ff0b36e6b3b5196a0f343243c3e53fcb5a12c641394c71ee88c96c3cf0a8f` |
| `com.docker.backend.exe` | `ev_b5327938e766e62a5a4081ae4f6228dccee088f0ff75154aaaa3a62897024f56` |

실제 네 CLI 결과는 최상위가 Evidence인 JSON이다. 원본의 저장 결과는 `ok/data/meta` envelope이므로 두 구조를 구분해 확인했다. 네 결과의 `coverage.status=complete-within-substeps`는 해당 inventory 단계 안의 완료를 뜻한다. 공통 제한은 `Artifact has no child container entries`와 정적 inventory가 실행·형식별 의미 분석을 입증하지 않는다는 것이다. backend의 forwarding·named pipe·bind 변환 동작까지 확인한 것으로 해석하지 않는다.

- 원본 `inspect-managed-artifact` 저장 결과는 외부 `ok=true`여도 `data.code=resource_constraint`이며 snapshot 한도는 134217728 bytes다. 관리 코드 분석 성공이 아니다.
- 원본 `inspect-pe-resources` 저장 결과는 `maxFileBytes`의 허용 최대 536870912를 초과한 `VALIDATION_ERROR`다. 원본 PE resource를 REA로 열거했다는 근거는 없다.
- 파생 DOCKERDESKTOP 7z와 추출 `wsl-data.tar`에 대한 REA `inspect-artifact`는 각각 종료 1, `target_unavailable`, `unsupported binary format`이다. 이 둘의 멤버 인벤토리는 기본 `tar` 관찰이다.
- native decompile, IPC 추적, 실제 WSL 등록·시작, Windows PATH/context/plugin 검색, bind mount·interactive 실행은 하지 않았다. 설치 결과·동작 호환성은 미검증이다.

## 공개 문서와 DockSlate 설계의 구분

Docker의 [WSL 문서](https://docs.docker.com/desktop/features/wsl/)는 별도 일반 Linux 배포판 없이 Windows 터미널에서 CLI를 사용하며 Docker Desktop 자체 `docker-desktop` 배포판을 사용한다고 설명한다. [Windows 설치 문서](https://docs.docker.com/desktop/setup/install/windows-install/)는 설치 모드와 WSL backend를 설명한다. 이는 공개 문서 설명이며 위 4.96.0 원본에서 시작·설치 동작을 실행 관찰한 근거가 아니다.

DockSlate가 자체 소유 Linux 엔진을 유지하면서 공식 Windows CLI·plugins와 Windows broker를 제공하는 것은 별도의 설계다. 이번 관찰은 Windows 클라이언트와 Linux runtime 파일을 함께 배포하는 구성을 참고할 근거이며, Docker Desktop 파일·코드·VHDX·ISO를 DockSlate에 재배포하거나 그 동작을 복제했다는 의미가 아니다. Windows bind 경로 변환·named-pipe ACL·engine ownership·streaming/exec·취소는 DockSlate 구현과 검증이 따로 필요하다. 기존 WSL 삭제나 초기화는 필요 조건으로 삼지 않는다.

## 확인한 명령

- `Get-FileHash -Algorithm SHA256`와 원본 읽기 스트림 범위 복사: 종료 0, 원본 SHA 일치 및 네 파생 범위 길이·SHA 기록.
- `tar.exe -tf/-tvf <DOCKERDESKTOP.resource|DOCKERDESKTOPVM.resource>`: 종료 0, 197/2개 멤버와 선택 크기 확인.
- `tar.exe -xf <DOCKERDESKTOP.resource> -C <새 selected-members> <지정한 7개 멤버>`: 종료 0.
- `node <기존 rea.mjs> inspect-artifact <네 Windows PE> --json`: 각각 종료 0, 위 Evidence와 실제 제한 확인.
- 같은 REA 명령의 `<DOCKERDESKTOP.resource>`, `<wsl-data.tar>`: 각각 종료 1, 지원하지 않는 형식. `tar.exe -tf <wsl-data.tar>`는 종료 0, 11개 멤버.

정적 조사의 산출물은 이 연구문서와 `.analysis` 파생 조사 파일이다. 조사 원본의 변경·삭제는 없다.
