# MVP 구현 추가 근거

원본 [Rancher Desktop v1.24.0 분석](../research/rancher-desktop-1.24.0.md)과 Evidence·아티팩트 기록은 변경하지 않았다. 전체 ASAR 재분석, Rancher Desktop 설치·실행, WSL 배포판 생성은 수행하지 않았다. 구현 요청 이후 REA MCP 호출은 0회이며 [실행 로그 감사](rea-mcp-call-audit.md)로 별도 확인했다.

| 구분 | 확인·구현 내용 |
| --- | --- |
| 기존 REA 관찰 | Electron 모듈·IPC 표면과 Windows Moby `npipe:////./pipe/docker_engine` 경로. 부분 coverage와 미확인 호출 관계·런타임은 원본 보고서의 제한을 유지한다. |
| 기존 MSI 추가 조회 | 설치 없는 인벤토리에서 Docker CLI는 `resources/resources/win32/bin/docker.exe`, proxy 소유 프로세스는 `resources/resources/win32/internal/wsl-helper.exe`로 확인했다. REA 신규 분석 결과로 표기하지 않는다. |
| 공개 소스/API | WindowsIntegrationManager의 helper proxy와 Docker API 1.51의 선택 cache ID 필터·Pull 태그 동작. [버전과 소스 링크](docker-backend-evidence.md)에 추가 근거를 기록했다. |
| 독자 설계 | Electron IPC를 복제하지 않고 Tauri 명령을 Rust 백엔드에 제한했다. uninstall 등록·CLI context·named pipe 소유자·Linux Engine·API 범위·Engine ID를 검증하며 Docker Desktop과 containerd는 Moby 연결로 인정하지 않는다. |
| 독자 설계 | 컨테이너·이미지·로그·사용량은 Docker Engine API로 조회한다. 삭제는 대상·영향 preview, 명시적 승인, 2분·1회 token, 실행 직전 참조 재검증을 요구한다. 컨테이너·볼륨 자동 정리와 force 삭제를 제공하지 않는다. |
| 독자 설계 | WSL 디스크는 HKCU Lxss 등록과 실제 VHDX 경로로 식별한다. 백업 크기·SHA-256·파일 ID, 소유 런타임 설치·프로세스 종료, 전체 WSL 종료 상태, 동적 VHDX 분리, 관리자 권한을 확인할 수 없으면 압축을 차단한다. 원본·백업·부모 경로의 링크와 파일 교체를 검사한다. 런타임 종료·WSL shutdown·mount·detach·백업 생성은 자동 실행하지 않는다. |

Docker 정리 가능 추정치는 실행 가능한 이미지·cache 후보를 기준으로 한다. 미확인 용량은 `null`이며 0으로 바꾸지 않는다. VHDX 파일 크기 감소와 Windows 파일 할당 공간 변화는 별도로 반환한다. 후자는 [FILE_STANDARD_INFO.AllocationSize](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_standard_info)를 [GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex)로 읽은 전후 차이이다. 다른 프로그램이 변경한 볼륨 전체 여유 공간이나 물리 SSD 회수량으로 표현하지 않는다. 자체 아이콘에서 해당 API 조회만 검증했으며 VHDX 압축 결과는 확보하지 않았다.

Rancher Desktop Apache-2.0과 Dockhand BSL 1.1을 구분한다. 원본 코드·브랜드·에셋을 제품에 복사하지 않았다. 직접 의존성 manifest에서 React/React DOM·Vite의 MIT, TypeScript의 Apache-2.0, Tauri/API·serde/serde_json의 MIT/Apache-2.0 선택 라이선스를 확인했다. Windows EXE 생성 후 [의존성 고지](../../THIRD_PARTY_NOTICES.md)에 로컬 런타임·빌드 의존성의 라이선스와 확보한 원문을 기록했다. 누락된 라이선스 원문과 Microsoft WebView2 loader 및 Rust 표준 라이브러리의 배포 고지는 해당 문서에 미확인으로 남겼으며 외부 배포 고지 확정은 미완료이다.

연결된 엔진의 동작, 유효 승인 token의 만료·재사용, 선택 prune, 실제 등록 VHDX·백업·압축의 E2E는 미확인이다. [실행한 검증과 차단 조건](mvp-verification.md)을 기능 완료와 구분하여 기록했다.
