# IObit 접근 알림 검토 요청 초안 · 미전송

제출 경로: [IObit Online Feedback](https://www.iobit.com/en/onlinefeedback.php). 이 문서는 검토 가능한 초안이며 지원 요청·파일 업로드·개인 연락처 전송을 수행하지 않았다.

2026-11-03 문서 대조: 검토 후보 파일을 저장소의 0.1.6 배포 명세에 맞췄다. 과거 알림 대상과 현재 제출 후보는 다르며, 0.1.6에서 같은 알림이 재현됐다고 주장하지 않는다. 제출 전 실제 배포 버전과 [보안 상태](code-signing.md)를 다시 확인한다.

## 제출 본문

Subject: Please review Advanced SystemCare Access Protection alerts for DockSlate / its NSIS uninstaller

DockSlate is a Windows Docker management app using Tauri and Microsoft WebView2. Its public source is https://github.com/seo-gali/dockslate . Advanced SystemCare previously categorized accesses by the app and an NSIS temporary uninstaller as "Browser" under Access Protection. The alert did not identify a malware detection name or the protected target file.

Release candidate supplied for review: DockSlate 0.1.6. Installer SHA-256: `E8699FEDC93C31081E73D792BB55A596AA326EA988ABD3C8BD5575144D6B8525`. Embedded app SHA-256: `3DACD6FDC1DFECA7917EA6FB0C1E2812DE758160F9ADDDB142709CAFB004DA67`. Both are unsigned. Published release URL: https://seo-gali.github.io/dockslate/downloads/DockSlate_0.1.6_x64-setup.exe . The original alerts involved earlier artifacts; the same alert has not been established for this review candidate.

Source inspection found no direct code for reading personal Chrome, Edge or Firefox cookies, passwords or history. A prior, limited Process Monitor trace of an older release recorded 17,751 filesystem events across installer/setup/uninstaller confirmation-and-cancel paths. App-specific WebView2 History/Cookies/Local State access was observed; personal browser profile access was not observed in that captured scope. This does not establish the original alert's exact cause or certify the current release's complete behavior.

Please identify the target path or rule responsible for this Access Protection category, and whether app-owned WebView2 profile access or NSIS app-data cleanup can trigger it. If the classification is incorrect, please advise the vendor-side review process. We are not requesting a blanket protection exception or asking users to disable protection.

Available evidence: public source and release, signed-tool trace summary, exact artifact hashes and test scope. Raw traces, browser data, personal paths and unrelated protection history will not be attached. Developer contact details must be provided by the developer at submission time.

## 첨부 후보

- 검토할 0.1.6 설치 파일 또는 공개 URL. 원래 경고 대상 파일과 구분한다.
- [접근 추적 범위와 결과](browsing-data-alert.md)·[집계 결과](browsing-data-access-e2e.json). 현재 버전의 모든 경로를 추적한 증거로 표현하지 않는다.
- 개인 브라우저 파일·원본 PML/CSV·보호 기록 전체·비밀값은 제출 대상에 포함하지 않는다.
