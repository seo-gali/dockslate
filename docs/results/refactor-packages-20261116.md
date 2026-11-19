# 구조 개편본 로컬 패키지 제작

제작 2026-11-16, 최종 수령·검증 2026-11-18. 사용자 요청에 따라 수정 소스를 앱·CLI·설치 EXE·포터블 ZIP으로 빌드했다. 앱 버전은 0.1.10을 유지하고 `downloads/local-refactor-20261116/`에 분리했다. 기존 0.1.10 배포 파일·체크섬과 공개 0.1.9 사이트를 변경하지 않았다. [제작 영수증](refactor-packages-20261116.json)에 정확한 파일 해시와 실행 범위를 기록한다.

## 완료한 검사

- `npm run check`: 종료 0. TypeScript·문서·IPC·workflow SHA·Node 검사 9개 통과.
- 앱·CLI 잠긴 오프라인 release 빌드: 종료 0. 화면 빌드와 라이선스 555개 구성 요소·고지 362개·소스 11개 검증 포함. 앱 ProductVersion·FileVersion 모두 0.1.10.
- `scripts/package-local.ps1 -OutputDirectory downloads/local-refactor-20261116`: 종료 0. 기존 출력 대신 지정한 로컬 폴더에 제작했다. 출력 경로의 작업 폴더 이탈·reparse point를 거부한다.
- ZIP 내부 401개 파일을 포터블 디렉터리와 크기·SHA-256으로 전수 대조했다. 앱·CLI·공식 도구·라이선스·예제·공통 문서와 현재 빌드 입력도 대조했다.
- 격리된 임시 프로필의 CLI `--version`, `--debug --version`, `compose version`, `buildx version`: 4개 모두 종료 0. 엔진 연결·기존 프로필 사용 없음.
- 기존 EXE·ZIP·고지 ZIP·체크섬과 npm/Rust 잠금 파일의 해시 6개를 대조해 보존을 확인했다.

## 설치 EXE 제작과 검증

로컬 NSIS는 샌드박스와 일반 로컬 실행에서 모두 `src-tauri/installer/user-path.ps1` 읽기 오류로 중단됐다. 파일은 존재하며 PowerShell 해시 읽기는 성공한다. 이번 실패를 특정 보안 제품 탓으로 확정하지 않았으며 보안 설정·예외·파일 우회는 적용하지 않았다.

사용자 승인 후 앱·CLI와 ZIP의 동봉 문서 3개를 담은 입력 ZIP(2,303,743바이트)을 임시 `build/refactor-installer-20261116` 브랜치에 푸시했다. [GitHub 빌드 1회](https://github.com/seo-gali/dockslate/actions/runs/43870975182)가 성공했고, artifact 49,314,463바이트를 GitHub 공식 SHA-256 `e65affa99e84ab95f4952530afc050cf08b2d5850ba588882695212f0dfe47f8`과 대조한 뒤 내부 설치 EXE 체크섬도 확인했다.

설치 EXE와 ZIP의 공통 파일 397개·동봉 문서 3개·앱/CLI·설치 보조 스크립트를 확인했다. 안내/예제 텍스트 9개는 CRLF 차이만, 공식 구성 요소 명세 JSON 1개는 들여쓰기만 달라 내용의 동일성을 별도 확인했다. 바이너리와 라이선스 원문은 정확한 SHA로 대조했다. ZIP 401개 파일은 각각 포터블 디렉터리와 정확한 크기·SHA가 일치한다.

| 파일 | 바이트 | SHA-256 |
| --- | ---: | --- |
| `DockSlate_0.1.10_x64-setup.exe` | 49,319,749 | `65EA290B2EEF49D48DBA4DF52838E4532D7578814E18FAAAB15897B49C9D40B3` |
| `DockSlate-0.1.10-windows-x64.zip` | 62,962,235 | `53828A69A1F64894D65F1C0EDA48C3ECC296DC71C2E1F2C439C7745D5B0AC3A4` |

검증 후 임시 원격/로컬 빌드 브랜치와 격리 worktree를 삭제했다. 입력 ZIP·내려받은 전달 ZIP·압축 해제 사본을 정리하고 영수증·추출 로그·최종 파일을 보존했다. main에는 커밋·푸시하지 않았으며 공개 Release·사이트는 그대로다. 동봉 문서는 제작 시점 스냅샷이다.

새 파일의 VirusTotal 제출·서명·실제 설치/제거·새 앱 GUI/엔진 회귀는 수행하지 않았다. 이전 0.1.10 설치 EXE의 탐지와 새 바이너리의 검사 상태는 해시가 다른 별개 대상이며, 새 파일의 안전 판정으로 재사용하지 않는다.

이 패키지는 후속 보안 점검 요청 전에 제작된 소스다. 후속 점검에서 추가 수정이 생기면 그 수정은 이 해시의 설치판에 자동 반영되지 않는다.
