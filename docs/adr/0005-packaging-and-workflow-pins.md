# ADR 0005: 패키징·고정된 CI 입력

상태: 채택 · 기록일: 2026-11-24 · 기존 구현의 결정을 주석에서 이전함.

## 배경

패키지는 오래된 문서를 섞지 않고 기존 고지 주소를 유지해야 한다. CI 실행 코드는 이동 가능한 태그 대신 전체 커밋 SHA로 고정한다.

## 결정

원래 위치는 검토 기준 커밋 `c439a2e14748a769b24d0c70f9cc487358126cda`의 줄 번호다. C 번호는 [전체 분류](../results/comment-review.json)의 항목과 대응한다.

| 항목 | 원래 위치 | 유지할 결정 |
| --- | --- | --- |
| C01 | `.github/workflows/pages.yml:30` | 기존 버전 표기 v6의 실행 참조는 - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 이다. 실행 시 전체 SHA 고정을 유지한다. |
| C02 | `.github/workflows/pages.yml:40` | 기존 버전 표기 v6의 실행 참조는 - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 이다. 실행 시 전체 SHA 고정을 유지한다. |
| C03 | `.github/workflows/pages.yml:43` | 기존 버전 표기 v6의 실행 참조는 - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 이다. 실행 시 전체 SHA 고정을 유지한다. |
| C04 | `.github/workflows/pages.yml:47` | 기존 버전 표기 v4의 실행 참조는 - uses: actions/upload-pages-artifact@7b1f4a764d45c48632c6b24a0339c27f5614fb0b 이다. 실행 시 전체 SHA 고정을 유지한다. |
| C05 | `.github/workflows/pages.yml:63` | 기존 버전 표기 v4의 실행 참조는 uses: actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e 이다. 실행 시 전체 SHA 고정을 유지한다. |
| C06 | `.github/workflows/workflow-pins.yml:20` | 기존 버전 표기 v6의 실행 참조는 - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 이다. 실행 시 전체 SHA 고정을 유지한다. |
| C07 | `.github/workflows/workflow-pins.yml:24` | 기존 버전 표기 v6.5.0의 실행 참조는 - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 이다. 실행 시 전체 SHA 고정을 유지한다. |
| C08 | `.github/workflows/workflow-pins.yml:36` | 기존 버전 표기 v6의 실행 참조는 - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 이다. 실행 시 전체 SHA 고정을 유지한다. |
| C09 | `.github/workflows/workflow-pins.yml:39` | 기존 버전 표기 v6.5.0의 실행 참조는 - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 이다. 실행 시 전체 SHA 고정을 유지한다. |
| C10 | `.github/workflows/workflow-pins.yml:50` | 기존 버전 표기 v6의 실행 참조는 - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 이다. 실행 시 전체 SHA 고정을 유지한다. |
| C11 | `.github/workflows/workflow-pins.yml:53` | 기존 버전 표기 v6.5.0의 실행 참조는 - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 이다. 실행 시 전체 SHA 고정을 유지한다. |
| C12 | `scripts/build-site.mjs:71` | 이전 패키지가 참조하는 고지 URL을 계속 제공한다. |
| C13 | `scripts/check-workflow-pins.mjs:11` | 문자열·설명·run 블록을 액션 uses 참조로 오인하지 않는다. |
| C14 | `scripts/package-docs.mjs:23` | 빈 출력 디렉터리만 받아 오래된 문서가 배포본에 섞이는 것을 막는다. |

## 영향

사람용 버전 표기는 이 ADR에서 확인한다. 버전 표기를 제거해도 workflow의 실행 SHA·권한·조건은 바꾸지 않는다.

[주석 정책](../COMMENT_POLICY.md) · [ADR 목록](README.md)
