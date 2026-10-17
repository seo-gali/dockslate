# Codex 세션 REA MCP 호출 감사

- 세션 ID: `01a13080-4613-79f3-a5cc-3a6f1cf4c680`
- 근거: 로컬 Codex JSONL의 `exec` 호출 코드와 도구 반환 결과. 분석 보고서의 서술을 호출 기록으로 간주하지 않음.
- 원본 로그: `C:/Users/user/.codex/sessions/2026/10/12/rollout-2026-10-12T23-24-35-01a13080-4613-79f3-a5cc-3a6f1cf4c680.jsonl`
- REA 호출 발생: **확인됨**. 2026-10-12 23:27:45–23:43:57 KST의 초기 분석 작업에서 **20회**.
- 정상 응답 16회, 오류 응답 4회. 정상 응답에는 부분 결과와 일치 항목 0건이 포함되므로 완전한 분석 성공 16회라는 의미가 아님.
- 14개의 `exec` 안에서 실행된 개별 REA 호출을 집계. 반복·병렬 호출을 각각 세며 `wait`, 도구 목록 조회, 문서의 도구 이름 언급은 제외.
- MVP 구현 요청 이후 REA 호출 **0회**. 관련 서브에이전트 4개의 로그에서도 REA 호출 **0회**.
- 이번 감사에서 새 REA 호출 **0회**. REA 서버 측 독립 감사 로그는 확인하지 않음.

| REA 도구 | 호출 | 정상 응답 | 오류 |
| --- | ---: | ---: | ---: |
| `binary_session` | 2 | 2 | 0 |
| `analyze_javascript_application` | 2 | 1 | 1 |
| `inspect_analysis_view` | 7 | 7 | 0 |
| `get_evidence_bundle` | 1 | 1 | 0 |
| `recover_javascript_sources` | 1 | 0 | 1 |
| `trace_application_feature` | 5 | 4 | 1 |
| `trace_javascript_semantics` | 2 | 1 | 1 |
| **합계** | **20** | **16** | **4** |

오류 4회는 전체 ASAR 분석의 MCP 300초 시간 초과, Wakaru 부재에 따른 복원 기능 사용 불가, 기능 추적 입력 검증 오류, 의미 추적 결과의 MCP 응답 크기 초과이다. 입력 검증 오류는 REA 호출 시도 기록이며 기능 분석 실행 완료로 간주하지 않는다. 서버 내부 분석 실행 횟수는 이 로그만으로 확정할 수 없다.

개별 UTC 시각, 호출 ID, 원본 로그 행 번호, 반복 횟수, 반환 상태 및 로그 스냅샷 해시는 [rea-mcp-call-audit.json](rea-mcp-call-audit.json)에 기록했다. 원본 REA 분석·Evidence 파일은 변경하지 않았다.
