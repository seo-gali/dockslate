# Windows 코드 서명

**상태: 미서명 개발 빌드 다운로드 허용.** 사용자의 요청으로 설치판·ZIP·CI의 강제 서명 차단을 제거한다. 미서명 표시와 SHA-256 검증을 유지하며, 보안 경고가 해결됐다는 의미는 아니다.

## 2026-10-31 현재 확인과 해결 경로

공개 0.1.5 설치 EXE와 검증된 앱은 현재도 `NotSigned`이며, 사용자·컴퓨터 개인 저장소에 코드 서명 인증서는 없다. 인증서의 공개 메타데이터만 확인했고 개인 키는 읽지 않았다. Windows Defender는 비활성 상태이며 IObit Malware Fighter가 보안 제품으로 등록돼 있다. Defender 검사를 통과했다고 표시하지 않으며 보안 제품 설정은 바꾸지 않았다.

과거 알림은 Advanced SystemCare의 데이터 접근 보호 분류이며, 당시 악성코드 탐지명이나 보호 대상 파일 경로는 확보되지 않았다. 확인한 이전 설치·취소 경로의 파일 이벤트 17,751건에서는 앱 전용 WebView2 데이터 접근이 있었고 개인 브라우저 프로필 접근은 0건이었다. **현재 0.1.5 전체 경로의 재검사나 원래 알림의 오탐 확정은 아니다.** [검사 대상·범위](browsing-data-alert.md).

- 앱이 개인 브라우저 데이터를 읽는 경로가 관측되면 해당 접근을 코드에서 제거하고 같은 경로를 재검사한다. 현재 소스에서 그런 직접 접근 경로는 발견되지 않았다.
- 앱 전용 WebView2 데이터 접근을 보안 제품이 분류한 경우에는 IObit에 정확한 대상 경로·배포 파일·진단 범위를 제출해 검토받아야 한다. 현재는 제출안을 준비한 상태이며 파일 업로드·지원 요청 전송은 하지 않았다. 신뢰 목록 추가나 보호 해제는 해결 근거로 삼지 않는다.
- 게시자 신원·파일 출처 표시는 정식 코드 서명으로 보완할 수 있다. 인증서 발급·신원 확인과 서명 계정 승인이 필요하며, 서명만으로 이 접근 보호 알림의 해소를 보장하지 않는다. 계정 생성·결제·키 열람·신뢰 등록은 하지 않았다.

SHA-256은 다운로드 파일이 게시한 배포본과 같은지 확인한다. 백신 검사·코드 서명·파일 접근 추적은 각각 다른 검증이다. 다운로드 화면은 이 용도를 직접 설명하도록 정리했으며 검사 미수행을 안전 판정으로 바꾸지 않았다. 공개 설치 파일·ZIP은 이 문서 수정으로 교체되지 않는다.

| 2026-10-22 확인 | 결과 |
| --- | --- |
| 사용자·컴퓨터 개인 인증서 저장소 | 코드 서명 인증서 없음. 공개 메타데이터만 조회 |
| Windows SDK 서명 도구 | 설치됨 |
| 현재 설치판·앱·Windows CLI 래퍼 | 모두 `NotSigned` |
| 브라우징 데이터 접근 경고 | 원인 미확인. [기존 조사](browsing-data-alert.md) |

## 개발 빌드 제공

- 앱·자체 CLI 래퍼·설치 EXE는 미서명 개발 빌드로 제공한다. 안내서에서 설치 EXE·전체 ZIP을 받을 수 있으며, 서명 계정이나 인증서를 요구하지 않는다.
- 기존 소스 빌드 기록·공식 Docker 구성 요소의 고정 해시·ZIP 내부 파일·최종 산출물의 SHA-256 검증을 유지한다. 해시 일치는 파일 무결성 확인이며 악성코드 검사 결과가 아니다.
- 사용하지 않는 강제 서명 검사 스크립트 2개와 차단 전용 검증 기록 2개를 삭제한다.
- 정상 Windows 신뢰 체인을 유지한다. 자체 서명 인증서를 신뢰 저장소에 추가하거나 보안 제품 예외를 설정하지 않는다.
- 기존 통합 검사 기록은 서명 전 바이너리 해시다. 정식 서명으로 파일이 바뀌면 해당 파일의 검증 기록과 패키지 해시도 다시 작성·검증해야 한다.

## 정식 서명 준비

사용자는 한국 개인 개발자라고 확인했다. 따라서 Microsoft Public Trust 개인 신청은 현재 대상이 아니다. 저장소 루트에 프로젝트 라이선스가 없어 SignPath 무료 신청의 OSI 라이선스 조건 충족도 미확인이다. 라이선스를 임의로 지정하지 않는다.

1. 발급 주체·국가에 맞는 코드 서명 인증서 또는 서비스의 신원 확인을 완료한다. 이 과정의 계정 생성·결제·비밀 사용은 사용자 승인 후 진행한다.
2. 발급 방식에 맞춰 Tauri의 `bundle.windows.certificateThumbprint` 또는 `signCommand`를 설정한다. 자체 CLI 래퍼도 먼저 서명하고, 설치판·제거 프로그램의 서명을 확인한다. 현재 서명 연동은 미구현이다.
3. 정식 서명 적용 시 지정 게시자·타임스탬프 검증과 새 파일의 설치·CLI 검증을 수행한다. 접근 경고 원인 조사와 정상 보안 검사는 별도로 완료한다. 현재 개발 빌드 다운로드에는 서명을 필수로 요구하지 않는다.

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

## 다운로드 복구 검증

| 명령 | 실제 결과 |
| --- | --- |
| `npm run package:local` 수정 전 | 종료 1, 서명 신원 미설정으로 차단되는 오류 재현 |
| `npm run package:local` 수정 후 | 종료 0, 서명 없이 ZIP 생성. 실제 EXE·공식 구성 요소·라이선스 10개 ZIP 내부 해시 확인 |
| `npm run build` | 종료 0, TypeScript·Vite·dist 안내서 생성 통과 |
| `node scripts/verify-guide.mjs .analysis/guide-browser-download-session.json` | 종료 0, 실제 격리 Chrome의 11개 검사 통과. root/dist 안내·EXE/ZIP 실제 다운로드와 원본 해시 일치·추출 ZIP 안내·공유 HTML·390px·JS 오류 없음. [기록](guide-delivery-e2e.json) |

위 다운로드 복구 검사는 2026-10-22의 설치판 SHA-256 `8C3606C8FB14E9B81DEA0B217006EACD9B39DA284F30DA5E08A6919D30BE1094` 범위다. 당시 새 설치판 빌드·서명·설치·제거·엔진 조작은 수행하지 않았다. 이후 버전의 실제 산출물·해시·서명 상태는 [최신 배포 기록](installer-engine-integration.json)에서 확인한다. 보안 설정 변경이나 경고 해소를 의미하지 않는다.

## 0.1.6 배포물 확인

2026-10-31. 새 앱·자체 CLI·설치 EXE의 Authenticode는 모두 `NotSigned`다. [0.1.6 빌드·읽기 전용 검사와 설치 파일 내부 대조](release-0.1.6.md)는 파일 구성과 관측한 동작의 근거이며 코드 서명·백신 검사·원래 IObit 알림의 원인 확정을 대신하지 않는다. 공급업체 문의는 초안만 작성했으며 전송하지 않았다.
