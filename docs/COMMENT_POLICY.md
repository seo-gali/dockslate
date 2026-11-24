# 코드 주석 정리

직접 관리하는 앱·스크립트·설정의 설명 주석을 추가하지 않는다. 이름과 구조로 동작을 표현하고, 코드만으로 알 수 없는 중요한 결정은 [ADR](adr/README.md)에 남긴다. 라이선스 원문·타사 자료·생성물·문서 속 예제 문자열은 이 정책의 삭제 대상이 아니다.

## 분류와 처리

| 분류 | 판단 | 처리 |
| --- | --- | --- |
| Tautology | 바로 옆 코드가 이미 표현하는 내용 | 삭제 |
| Stale | 현재 구현과 맞지 않는 내용 | 삭제 |
| Excuse | 취약한 구현을 유지하게 만드는 변명 | 삭제하고 구체적인 개선 이슈 작성 |
| Decision Record | 코드만으로 이해하기 어려운 중요한 선택 | ADR로 이동 |

단순히 `shortcut`이라는 단어가 있다고 Excuse로 분류하지 않는다. 실제 제한과 호출 관계를 확인한다. 예를 들어 느린 창 때문에 설치를 무한정 기다리지 않는 시간 예산은 보존할 결정이고, 검사 도구가 라이브러리의 비공개 메시지 번호에 묶인 것은 개선할 대상이다.

## 검사와 ratchet

`node scripts/check-comments.mjs`는 Git 추적 파일과 Git에 무시되지 않은 새 파일을 검사한다. 대상은 `src/`, `src-tauri/`, `scripts/`, `site/` 등의 직접 관리 코드와 YAML·TOML·Dockerfile·Git 설정이다. `docs/`, `licenses/`, `downloads/`와 Git 무시 생성물은 제외한다. 문자열·정규식·템플릿·here-document 속 내용은 바깥 언어의 주석으로 취급하지 않는다. 새 코드 언어를 도입하면 검사기의 대상과 해당 언어 검사를 함께 확장한다.

기존 예외는 `scripts/comment-baseline.json`에 파일·내용·뒤따르는 코드의 지문과 개수로 고정한다. 같은 개수의 다른 주석으로 바꿔도 실패한다. 삭제는 허용하고 `node scripts/check-comments.mjs --ratchet`으로 기준선을 줄인다. 이 명령으로 새 주석을 기준선에 추가할 수 없다. `npm run check`와 소스 CI에서 같은 검사를 실행한다.

두 셸 진입점의 shebang과 여섯 `@ts-expect-error`는 실행·컴파일 지시문이다. 설명은 ADR로 옮기고 지시문만 남긴다. 지시문까지 지워서 실행 방식이나 음성 타입 검사의 의미를 바꾸지 않는다. 새 지시문이 필요하면 기능적 필요와 ADR을 검토하고 기준선 변경을 명시한다.

`node scripts/check-comments.mjs --inventory`로 현재 목록을 JSON으로 얻는다. 정리 전 전체 분류·원문·이동 위치·줄 수는 [검토 기록](results/comment-review.json), 남은 구현 과제는 [트레이 검사 이슈](issues/tray-probe-private-messages.md)에 기록한다. 재실행에는 저장소의 `.agents/skills/delete-comment/SKILL.md`를 사용한다.
