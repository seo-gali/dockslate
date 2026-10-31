# 문서·죽은 코드·임시 자료 정리

2026-10-31. 로컬 소스·문서를 수정하고 검증했다. Slack·Statsig 조회 도구는 연결돼 있지 않아 해당 서비스의 사용량을 확인했다고 주장하지 않는다. 패키지·서명·공개 배포물은 다시 만들거나 게시하지 않았다.

## 실제 변경

- README 개발 설명을 [개발 안내](../DEVELOPMENT.md)로 분리하고 Pages의 깨진 강조 표기를 코드 표기로 정리했다.
- 루트 `CODING_STANDARDS.md`·`DESIGN.md`를 `docs/`로 이동하고 관련 링크를 갱신했다. 루트 파일은 19→17개다. Pages·검색 인증 파일, 빌드 설정, 사용자 안내·고지는 유지했다. AGENTS의 경로만 맞췄고 지시 의미의 변경은 [수정안](agents-instructions-review.md)으로 남겼다.
- import·호출이 없는 `src/containerCommand.ts`와 `containerReadCache.ts::readContainerLogs`, 이 함수 전용 pending Map·backend import를 제거했다. 로그 화면은 기존 `cachedLogs`·`storeContainerLogs` 경로를 계속 사용한다. 빌드 화면의 미사용 import와 열 조절 콜백의 미사용 인자도 정리했다.
- 기본 export를 lazy import로 사용하는 화면 3개와 수동 검증·번역 도구는 유지했다. 정적 참조 후보라는 이유만으로 화면·수동 도구를 삭제하지 않았다.
- [보안 기록](code-signing.md)은 Access Protection 알림, 코드 서명, 파일 동일성 검사를 구분하도록 보완했다. 홈페이지·가이드는 해시 용도를 직접 설명하며 오탐 확정·보안 검사 통과로 바꾸지 않았다. [IObit 제출 초안](iobit-access-review-draft.md)은 미전송이다.

## 검증

TypeScript 미사용 검사에서 미사용 import 1개·인자 2개가 출력됐고, 수정 후 `tsc --noEmit --noUnusedLocals --noUnusedParameters`는 종료 0이다. 최초 진단 명령의 개별 종료 코드를 별도로 보존하지 않아 임의로 기록하지 않는다. `npm run build`는 종료 0·83개 모듈이다. 사이트 미리보기 생성도 종료 0이며 현행 다운로드 3개 해시를 확인했다. 앱의 빌드·실행 경로를 바꾸지 않은 문서 정리를 이유로 설치·엔진·사용자 컨테이너 검사를 반복하지 않았다.

## .analysis 추가 정리 후보

측정 2026-10-31T10:29:45.2806523Z, 총 7.71 GB. 현재 작업에서 새로 만든 A/B worktree는 이 측정 이후의 별도 임시 자료다. 아래 디렉터리 합계 약 2.04 GB는 상한이다. 구버전 installer 폴더의 작은 JSON·검증 스크립트는 남기고 다운로드·추출 사본만 제거해야 한다. 이 요청은 추가 후보 확인이므로 아직 삭제하지 않았다. [경로·크기·중복 해시 근거](analysis-cleanup-candidates.json).

| 후보 | 크기 |
| --- | ---: |
| `installer-0.1.1` | 378.3 MB |
| `installer-0.1.2` | 378.3 MB |
| `ui-release-native` | 309.9 MB |
| `compose-mongodb-shell` | 207.9 MB |
| `table-cli-offline-b8b830439a6d425eabc18a18f49f4721` | 103.4 MB |
| `cli-release-0.1.1-2eb42ebd0eab461d9fa1aa4e49ec2a89` | 103.4 MB |
| `portable-cli-5d08290ae30b424f940989f27befc0b7` | 103.4 MB |
| `current-cli-gsi8c6` | 103.4 MB |
| `native-cli-offline-20261021183140` | 103.4 MB |
| `native-cli-offline-1792578980244` | 103.4 MB |
| `ui-cleanup-native` | 78.4 MB |
| `mongosh-2.14.0-win32-x64.zip` | 63.4 MB |

Compose·Buildx 파일은 각각 동일한 해시로 6개씩 존재한다. 한 묶음을 남기면 중복 5묶음 517.0 MB가 확인된다. 현행 공식 파일과 같은 해시라는 뜻은 아니며 옛 테스트 플러그인 사본끼리의 중복이다. 현재 이 작업 폴더의 테스트 브라우저 프로필을 사용하는 프로세스는 관측되지 않았다. 삭제 시점의 프로세스·잠금 재검사는 필요하다.

Docker Desktop·Rancher Desktop 조사 원본 약 3.14 GB, 라이선스 조사 원본, 원래 접근 경고의 추적 자료와 커널 원복 기록은 보존 대상이다. 실행 중 커널은 `D:\Program Files\DockSlate\runtime\kernels`에 있어 이 정리 범위에 포함되지 않는다. 작업 시작 때 이미 삭제 상태였던 0.1.3·0.1.4 루트 고지 ZIP은 이번 변경으로 삭제한 파일이 아니며 해당 삭제를 커밋·게시하지 않았다.

최종 문서 검사는 46개 문서·로컬 링크 312개, 누락 0개다. AGENTS의 기존 순서 문장은 유지됐고 로컬 생성 HTML·가이드 사본이 원본과 일치한다. `git diff --check`도 종료 0이다. 실험을 위해 새로 만든 worktree 654372436B는 결과·답변·패치를 보존한 뒤 제거했으며, 위 2.04 GB 사용자 정리 후보는 삭제하지 않았다.

## 승인 후 중복 정리

이후 사용자의 삭제 승인으로 Compose·Buildx 중복 5묶음 10개 파일(516,953,800B)을 제거하고 한 묶음을 보존했다. 같은 내용의 과거 `docs/` 사이트 생성물·설치 EXE·포터블 사본 12개(112,577,578B)도 제거했다. 공개 게시본은 루트에서만 생성한다. `site/`·`src/`·`src-tauri/`는 서로 다른 원본이므로 유지한다. 이전 설치판의 고지 URL·조사 원본·실행 커널·WSL·볼륨은 보존했다. 위 “미삭제” 설명은 최초 후보 조사 시점의 상태이며 실제 삭제는 [후속 기록](repository-cleanup.json)에 구분했다.
