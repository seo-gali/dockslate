# Windows 코드 서명

**상태: 서명 미완료, 설치판·ZIP 제공 중단.** 기존 파일은 조사 자료로 보존한다. 보안 경고가 해소됐다는 의미로 서명을 사용하지 않는다.

| 2026-10-22 확인 | 결과 |
| --- | --- |
| 사용자·컴퓨터 개인 인증서 저장소 | 코드 서명 인증서 없음. 공개 메타데이터만 조회 |
| Windows SDK 서명 도구 | 설치됨 |
| 현재 설치판·앱·Windows CLI 래퍼 | 모두 `NotSigned` |
| 브라우징 데이터 접근 경고 | 원인 미확인. [기존 조사](browsing-data-alert.md) |

## 배포 조건

- 앱·자체 CLI 래퍼·최종 설치 EXE는 Windows가 유효하다고 판정한 내장 Authenticode 서명과 타임스탬프가 있어야 한다. 지정한 게시자 인증서의 Subject와 일치해야 한다.
- `DOCKSLATE_SIGNER_SUBJECT`는 발급받은 공개 인증서의 Subject 전체 문자열이다. 개인 키·암호가 아니며, 미설정이면 제작·업로드를 중단한다. 서명 계정 준비 없이 이 값만 채워도 서명은 생성되지 않는다.
- 검증은 `scripts/verify-code-signatures.ps1`을 사용한다. 설치판 제작은 자체 EXE를 묶기 전과 최종 설치판 생성 후, ZIP은 복사 전에 검사한다. CI는 업로드 직전에도 검사한다.
- 정상 Windows 신뢰 체인을 사용한다. 자체 서명 인증서를 신뢰 저장소에 추가하거나 보안 제품 예외를 설정하지 않는다. 공식 Docker 구성 요소는 기존 고정 해시 검증을 유지한다.
- 기존 통합 검사 기록은 서명 전 바이너리 해시다. 정식 서명으로 파일이 바뀌면 해당 파일의 검증 기록과 패키지 해시도 다시 작성·검증해야 한다.

## 정식 서명 준비

사용자는 한국 개인 개발자라고 확인했다. 따라서 Microsoft Public Trust 개인 신청은 현재 대상이 아니다. 저장소 루트에 프로젝트 라이선스가 없어 SignPath 무료 신청의 OSI 라이선스 조건 충족도 미확인이다. 라이선스를 임의로 지정하지 않는다.

1. 발급 주체·국가에 맞는 코드 서명 인증서 또는 서비스의 신원 확인을 완료한다. 이 과정의 계정 생성·결제·비밀 사용은 사용자 승인 후 진행한다.
2. 발급 방식에 맞춰 Tauri의 `bundle.windows.certificateThumbprint` 또는 `signCommand`를 설정한다. 자체 CLI 래퍼도 먼저 서명하고, 설치판·제거 프로그램의 서명을 확인한다. 현재 서명 연동은 미구현이다.
3. 지정 게시자·타임스탬프 검증과 새 파일의 설치·CLI 검증을 수행한다. 접근 경고 원인 조사와 정상 보안 검사는 별도로 완료한다. 다운로드 안내 복구는 그 뒤에 진행한다.

2026-10-22 공식 안내 비교. 게시자는 인증서에 확인된 개발자·조직이며, CA는 인증서 발급자다. Let’s Encrypt의 HTTPS 인증서는 EXE 코드 서명에 사용할 수 없다.

| 발급 경로 | 한국 개인 개발자 조건 | 공개 요금·추가 조건 |
| --- | --- | --- |
| [Microsoft Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) | 개인 Public Trust는 미국·캐나다만 지원. 한국 조직은 별도 지원 | 현재 사용자에게 적용 불가 |
| [DigiCert](https://www.digicert.com/signing/code-signing-certificates) | 한국 비사업자 개인 발급 가능 여부 미확인 | 월 USD 44부터 표시·12개월 자동 갱신. 선택별 연간 표시액이 달라 최종 총액 미확정. [요청 절차](https://docs.digicert.com/en/certcentral/order-and-manage-certificates/request-certificates/request-a-code-signing-or-ev-code-signing-certificate/request-code-signing-certificate.html) |
| [GlobalSign](https://shop.globalsign.com/en/code-signing) | 등록된 조직 명의만 발급한다고 명시 | 한국 지역 견적 미확인. 현재 비사업자 개인의 후보에서 제외 |
| [SSL.com IV](https://www.ssl.com/products/software-integrity/code-signing/iv/) | 사업자 등록 없는 개인용 제공. 한국 신청·신분증 수용 여부는 미확인 | 1년 인증서 USD 129. 토큰 USD 379 또는 별도 클라우드 서명 구독 등 추가 비용. 세금·배송·최종 견적 미확인 |
| [SignPath Foundation](https://signpath.org/terms.html) | 오픈소스 프로젝트 심사. OSI 라이선스 등 조건 필요 | 무료 승인 여부 미확인. 현재 프로젝트 라이선스 미지정으로 신청 준비 미완료 |

[Tauri 공식 서명 안내](https://v2.tauri.app/distribute/sign/windows/) · [Microsoft 서명 검증 안내](https://learn.microsoft.com/en-us/windows/win32/seccrypto/using-signtool-to-verify-a-file-signature)

서명만으로 SmartScreen·타사 보안 경고가 모두 없어지지는 않는다. 이 작업에서는 키 생성·열람·내보내기, 인증서 신뢰 등록, 보안 설정 변경, 외부 서명 요청을 수행하지 않는다.

## 수행한 검증

| 명령 | 실제 결과 |
| --- | --- |
| Windows SDK `signtool verify /pa /all /tw downloads/DockSlate_0.1.0_x64-setup.exe` | 수정 전 실패 재현, 종료 1, `No signature found` |
| `scripts/verify-distribution-signing.ps1 -SignedReference <설치된 SDK x64 signtool.exe>` | 종료 0, 11개 통과. Microsoft의 정상 내장 서명 수용·실제 미서명 설치판 거절·게시자 불일치·복사본 1바이트 변조 `HashMismatch`·신원 미설정 시 제작 차단·기존 산출물 해시 유지. [기록](code-signing-verification.json) |
| `npm run build` | 종료 0, TypeScript·Vite·dist 안내서 생성 통과 |
| `node scripts/verify-guide.mjs .analysis/guide-browser-signing-session.json` | 종료 0, 실제 격리 Chrome의 file:// 안내 7개 통과. root/dist 안내·EXE/ZIP 링크 없음·공유 HTML·390px·JS 오류 없음. [기록](guide-signing-gate-e2e.json) |

정식 인증서의 실제 서명·타임스탬프 발급·서명된 앱/래퍼/설치판/제거 프로그램 검증·재설치는 수행하지 않았다. 타임스탬프 없는 유효 서명 거절 분기는 실제 표본이 없어 미검증이다. 앱·설치판·변조 복사본은 실행하지 않았고 엔진·데이터는 변경하지 않았다.
