# Inspect 조회 수명

`AGENTS.md` → `CODING_STANDARDS.md#조회-수명`과 실제 구현을 대조했다. 호출 경로는 `src/pages/Containers.tsx` → `src/ContainerInspect.tsx` → `src/metadataCache.ts` → Rust `container_inspect`다.

수정 전에는 탭·메뉴를 숨겨도 진행 중 조회를 무효화하지 않았고, 조회 성공 전부터 해당 revision을 완료로 기록했다. 따라서 숨긴 화면에 늦은 결과가 반영되고, 실패 후 같은 탭을 다시 열어도 자동 재시도하지 않는다. 수정 범위는 Inspect의 응답 반영·성공 기록 시점이다. 공용 캐시와 백엔드·승인·데이터 처리 방식은 유지한다.

검증은 새 격리 프로필의 실제 Windows 앱과 기존 BusyBox 이미지로 만든 별도 컨테이너에서 수행한다. 포트·볼륨·사용자 파일·DB를 연결하지 않으며 외부 다운로드도 하지 않는다. 실제 IPC 결과의 전달을 잠시 지연하고, 별도 실패 검사에서는 잘못된 컨테이너 ID를 Rust로 전달해 실제 오류를 발생시킨다. 반환 데이터와 공용 캐시를 가짜 값으로 대체하지 않는다.

2026-10-27 실제 Windows 앱 검사: 수정 전에는 7개 중 숨긴 탭·숨긴 메뉴의 응답 반영과 실패 후 재활성화 3개가 실패했다(종료 1). 수정 후에는 7개 모두 통과했다(종료 0). 검사한 EXE SHA-256은 `8E3ED7AB97C15B0E17F94B618DAB906539F42394220CB50708BF0489950D7B25`다.

| 명령 | 결과 |
| --- | --- |
| `powershell -NoProfile -File scripts/desktop.ps1 -Mode build` | 종료 0, TypeScript·Vite·Windows release 빌드 성공 |
| `node scripts/verify-inspect-lifecycle.mjs .analysis/detail-lifecycle-session.json .analysis/inspect-lifecycle-fixture.json docs/results/inspect-lifecycle-e2e.json` | 종료 0, 실제 UI 검사 7개 통과 |
| 테스트 컨테이너 정리·기존 리소스 비교 | 지정한 중지 테스트 컨테이너 하나만 삭제. 기존 컨테이너 상태·볼륨 전체 결과·이미지/네트워크 ID 보존. 원래 엔진 중지 상태 복원 |

[수정 전 실패·수정 후 결과·정리 기록](inspect-lifecycle-e2e.json). 배포 중인 설치 EXE·ZIP을 교체한 검사가 아니며, 전체 앱의 모든 지침 준수나 프로덕션 배포 준비 완료를 뜻하지 않는다.
