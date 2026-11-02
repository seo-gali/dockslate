# 0.1.6 실제 재설치와 런타임 복구

2026-11-02. 사용자가 기존 데이터가 필요 없다고 확인하고 잔여 등록 정리·커널 복원·새 엔진 설치를 승인했다. 기존 `DockSlate` WSL 등록은 남았지만 등록 경로의 runtime·VHDX와 수동 지정 커널이 없었다. 파일들이 사라진 원인은 확정하지 않았다. [실제 명령·검사 결과](reinstall-recovery.json).

과거 소유권 기록과 일치한 등록만 정리하고, Microsoft 공식 커널 6.18.58.1의 동일 배포물·7개 파일을 대조해 `%LOCALAPPDATA%\DockSlateData\kernels\6.18.58.1`에 복원했다. `.wslconfig`의 kernel·kernelModules 두 경로만 바꾸고 나머지 설정을 보존했다. 새 엔진 데이터는 `%LOCALAPPDATA%\DockSlateData\runtime`에 있다. 두 위치는 앱 설치 폴더 밖이다. 커널 설정은 모든 WSL 2 배포판에 적용되지만, 전체 WSL 종료·Windows 재시작·다른 배포판 내부 변경은 실행하지 않았다.

실제 공개 0.1.6 설치 EXE를 실행해 `D:\Program Files\DockSlate`에 재설치했다. 설치 마법사의 성공 페이지와 실제 종료 코드 0, 설치 앱·CLI의 기존 검증 해시 일치를 확인했다. 설치 전후 새 런타임의 등록 ID·설치 ID가 같으며, 앱 화면과 Windows CLI가 동일한 새 엔진에 연결된다. CLI·커널·노출 조회 검사 14개와 설치된 앱 화면 검사 5개가 통과했다. 현재 Docker 29.8.2, 실행 커널은 `6.18.58.1-microsoft-standard-WSL2`이며 컨테이너·이미지·볼륨은 모두 0개다. 사용자 요청에 따라 기존 데이터는 복원하지 않았다.

| 실제 검증 | 결과 |
| --- | --- |
| `resume-engine.ps1` | 종료 0 · 소유권 확인 후 새 엔진 시작 |
| `DockSlate_0.1.6_x64-setup.exe` 대화형 설치 | 실제 종료 0 |
| `node .analysis/reinstall-recovery/verify-completion.mjs` | 종료 0 · 14개 통과 |
| `node .analysis/reinstall-recovery/verify-ui.mjs` | 종료 0 · 5개 통과 |
| `finish.ps1` | 종료 0 · 검증 창 종료·임시 파일 정리·일반 앱 실행 |

## 보안 공지와 현재 범위

해당 IPv4 TCP use-after-free는 [CVE-2026-98432](https://ubuntu.com/security/CVE-2026-98432), CVSS 9.8이다. [AWS 공지](https://aws.amazon.com/security/security-bulletins/2026-160-aws/)는 수정 커널 제공과 MPTCP 리스너에서의 원격 코드 실행 재현을 설명한다. Ubuntu·NVIDIA 커널 패키지의 제공 상태는 배포판별로 다르다. “수정 패치가 전혀 없다”거나 버전 숫자만으로 모든 장비의 상태를 판정할 수 없다.

이 PC는 Microsoft 해당 태그의 [inet_sock_destruct](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.18.58.1/net/ipv4/af_inet.c#L151)와 [tcp_v4_reqsk_destructor](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.18.58.1/net/ipv4/tcp_ipv4.c#L1151)의 `kfree_rcu()` 수정, 공식 패키지·영구 파일의 동일성, 실제 실행 커널을 확인했다. 파일 해시 일치는 동일성 확인이며 전체 안전성이나 침해가 없다는 보증은 아니다. WSL TCP 조회에는 DNS용 53번만 보였고 컨테이너 게시 포트·Windows portproxy는 없었다. 공유기·Windows 방화벽·실제 외부 도달성·DGX Spark는 점검하지 않았다. 공격 코드나 침해 여부 검사도 실행하지 않았다.

검증용 앱 창은 정상 종료했고 준비용 커널·패키지·WebView 프로필 293,066,714B를 정리했다. 실제 커널·새 엔진 데이터·검증 기록은 보존했으며 디버깅 인수 없이 일반 앱을 열었다. 앱 소스·의존성·버전은 변경하지 않았고 커밋·푸시도 실행하지 않았다. 수동 고정 커널의 후속 패치 관리와 코드 서명·원래 IObit 알림의 원인 확정은 별도 과제다.

원래 장시간 실행한 외부 명령의 종료 상태는 관찰하지 못했다. 자식 설치 기록의 완료와 후속 실제 엔진 시작·설치 EXE 종료 0·CLI·화면 검증을 근거로 현재 복구 완료를 판단했다. 앞선 설치 검증이 파일 내부 대조에 그쳤던 범위와 이번 실제 재설치를 구분한다.
