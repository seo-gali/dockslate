# IObit 접근 알림 검토 요청 초안 · 미전송

제출 경로: [IObit Online Feedback](https://www.iobit.com/en/onlinefeedback.php). 이 문서는 검토 가능한 초안이며 지원 요청·파일 업로드·개인 연락처 전송을 수행하지 않았다.

## 제출 본문

Subject: Please review Advanced SystemCare Access Protection alerts for DockSlate / its NSIS uninstaller

DockSlate is a Windows Docker management app using Tauri and Microsoft WebView2. Its public source is https://github.com/seo-gali/dockslate . Advanced SystemCare previously categorized accesses by the app and an NSIS temporary uninstaller as "Browser" under Access Protection. The alert did not identify a malware detection name or the protected target file.

Current public release: DockSlate 0.1.5. Installer SHA-256: `A9B1FF5ED188F7311BD7A764563AFEB8671C27CE1B3BFFCC6E2505DBB5284D46`. Embedded app SHA-256: `37C6C2E7398A2CAF33EABB722131D5F95EEF998F1596EBCF79D3CFB9174CE32D`. Both are unsigned. The release is available at https://seo-gali.github.io/dockslate/downloads/DockSlate_0.1.5_x64-setup.exe .

Source inspection found no direct code for reading personal Chrome, Edge or Firefox cookies, passwords or history. A prior, limited Process Monitor trace of an older release recorded 17,751 filesystem events across installer/setup/uninstaller confirmation-and-cancel paths. App-specific WebView2 History/Cookies/Local State access was observed; personal browser profile access was not observed in that captured scope. This does not establish the original alert's exact cause or certify the current release's complete behavior.

Please identify the target path or rule responsible for this Access Protection category, and whether app-owned WebView2 profile access or NSIS app-data cleanup can trigger it. If the classification is incorrect, please advise the vendor-side review process. We are not requesting a blanket protection exception or asking users to disable protection.

Available evidence: public source and release, signed-tool trace summary, exact artifact hashes and test scope. Raw traces, browser data, personal paths and unrelated protection history will not be attached. Developer contact details must be provided by the developer at submission time.

## 첨부 후보

- 공개된 0.1.5 설치 파일 또는 그 공개 URL.
- [접근 추적 범위와 결과](browsing-data-alert.md)·[집계 결과](browsing-data-access-e2e.json). 현재 버전의 모든 경로를 추적한 증거로 표현하지 않는다.
- 개인 브라우저 파일·원본 PML/CSV·보호 기록 전체·비밀값은 제출 대상에 포함하지 않는다.
