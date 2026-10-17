# 독립 WSL2 Moby 런타임 입력 근거

확인일: 2026-10-14. 이 문서의 배포 입력 조사는 공개 공식 문서와 HTTP GET/HEAD만 사용했다. 설치, WSL 배포판 생성·수정·시작·종료, Docker 데이터 변경을 조사 방법으로 사용하지 않았다. 별도 구현 검증에서 발견한 WSL 인자 처리 버그와 실패한 기본 배포판 기동 시도는 [실행 검증 기록](standalone-runtime-verification.md)에 명시했다. 기존 [Rancher Desktop 1.24.0 REA 결과](../research/rancher-desktop-1.24.0.md)는 보존하며 아래 내용을 새 REA 관찰로 취급하지 않는다.

## 공식 배포 입력에서 확인한 사실

| 입력 | 확인한 값 |
| --- | --- |
| Linux 배포판 | Ubuntu 24.04.5 LTS, noble, amd64 |
| 공식 이미지 | [ubuntu-24.04.5-wsl-amd64.wsl](https://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-wsl-amd64.wsl) |
| 이미지 SHA-256 | `bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e` |
| HTTP HEAD | 200, 같은 URL, 388975696 bytes, Last-Modified `Tue, 08 Sep 2026 00:19:19 GMT` |

SHA-256은 [Canonical SHA256SUMS](https://releases.ubuntu.com/noble/SHA256SUMS)와 [Microsoft WSL 배포 목록](https://github.com/microsoft/WSL/blob/master/distributions/DistributionInfo.json)의 Ubuntu-24.04 amd64 값이 일치했다. 이미지 전체를 다운로드하거나 로컬 해시를 비교한 것은 아니다. 다운로드 후 `Get-FileHash -Algorithm SHA256`로 위 고정 값과 비교할 수 있다.

[Canonical 설치 안내](https://documentation.ubuntu.com/wsl/latest/guides/install-ubuntu-wsl2/)는 새 `.wsl` 형식에 WSL 2.4.10 이상을 요구한다. [커스텀 배포판 안내](https://documentation.ubuntu.com/wsl/stable/howto/custom-ubuntu-distro/)는 `.wsl`가 tar 형식이며 `.tar`로 이름을 바꾸는 절차를 설명한다. [Microsoft import 명령](https://learn.microsoft.com/windows/wsl/basic-commands#import-a-distribution)은 배포판 이름·설치 위치·tar 입력·`--version 2`를 지원한다. DockSlate 이름으로 이 이미지를 import하는 실행은 미검증이다.

[공식 이미지 manifest](https://releases.ubuntu.com/noble/ubuntu-24.04.5-wsl-amd64.manifest)의 메모리 조회에서 apt 2.8.3, curl 8.5.0-2ubuntu10.13, ca-certificates, gnupg/gpg, systemd 및 systemd-sysv 255.4-1ubuntu8.17을 확인했다. iptables와 nftables 항목은 없었다.

## Docker 공식 Ubuntu apt 입력

[Docker 설치 문서](https://docs.docker.com/engine/install/ubuntu/)는 Ubuntu 24.04 amd64와 공식 apt 저장소를 지원한다. `https://download.docker.com/linux/ubuntu`, suite `noble`, component `stable`, architecture `amd64`, `Signed-By: /etc/apt/keyrings/docker.asc`를 사용하는 경로다. 정확한 버전 문자열을 `package=version`으로 지정할 수 있다.

[공식 서명키](https://download.docker.com/linux/ubuntu/gpg)를 메모리에 GET한 결과는 3817 bytes, SHA-256 `1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570`이다. 현재 키의 OpenPGP v4 primary packet fingerprint를 메모리에서 계산해 `9DC858229FC7DD38854AE2D88D81803C0EBFCD88`을 확인했다. [Docker maintainer의 과거 서명 검증 답변](https://github.com/docker/for-linux/issues/1471)도 같은 primary fingerprint를 명시한다. 이 계산은 패키지 서명 검증을 대신하지 않는다.

[공식 amd64 Packages](https://download.docker.com/linux/ubuntu/dists/noble/stable/binary-amd64/Packages)를 메모리에 GET해 다음 설치 입력을 확인했다. 최신 버전을 자동 선택한 결과가 아니라 사용할 수 있는 고정 버전이다.

| 패키지 | 정확한 apt 버전 | 메타데이터의 deb SHA-256 |
| --- | --- | --- |
| docker-ce | `5:29.8.2-1~ubuntu.24.04~noble` | `b53a44a6ff13277710978adbdbfea27fcdd7ac9f198017e733d2b8dc2343f8dc` |
| docker-ce-cli | `5:29.8.2-1~ubuntu.24.04~noble` | `008b3b49b474136063fe0fbe8999b0e77c3e8556d7f7de21f98f05715e2f76ba` |
| containerd.io | `2.3.6-1~ubuntu.24.04~noble` | `2eb8c6e244fe6886f2fa2eee9ec418c4b9bb44eb44fca748504f57c23341aed2` |
| [docker-buildx-plugin deb](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-buildx-plugin_0.38.0-1~ubuntu.24.04~noble_amd64.deb) | `0.38.0-1~ubuntu.24.04~noble` | `7094f8b50bc6b239292d475620424a531f7fa0763e466c52ffc3a4037e72bfc5` |
| [docker-compose-plugin deb](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-compose-plugin_5.6.0-1~ubuntu.24.04~noble_amd64.deb) | `5.6.0-1~ubuntu.24.04~noble` | `132266d499d9873aafcbe5b515997b8abd714914fa32a62ccac705c1ede7ca81` |

플러그인 두 행은 같은 공식 Packages를 추가 GET해 확인한 amd64 입력이다. 둘 다 Depends 항목이 없었다. 독립 guest CLI의 build 및 Compose 라벨 생성에 필요한 도구이며 GUI Compose 편집·배포 기능을 추가한 것은 아니다. 실제 설치·deb 해시 비교·Engine 29.8.2와의 E2E 호환성은 미검증이다.

실제 파일명은 [공식 pool](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/)의 `docker-ce_29.8.2-1~ubuntu.24.04~noble_amd64.deb`, `docker-ce-cli_29.8.2-1~ubuntu.24.04~noble_amd64.deb`, `containerd.io_2.3.6-1~ubuntu.24.04~noble_amd64.deb`이다. 파일명에는 apt epoch `5:`가 없다. deb 전체 다운로드·해시 비교는 하지 않았다.

docker-ce의 실제 Depends는 containerd.io >= 2.1.5, docker-ce-cli, iptables, nftables, libc6 >= 2.34, libsystemd0이다. containerd.io는 libc6 >= 2.38, libseccomp2 >= 2.5.0을 요구한다. containerd/runc는 Moby 내부 런타임 의존성이며 독립 Docker Engine 판정을 대신하지 않는다. iptables와 nftables는 Ubuntu 저장소 의존성으로 설치되므로 세 패키지 고정만으로 모든 OS 패키지의 완전한 버전 고정이 성립하지 않는다.

[공식 InRelease](https://download.docker.com/linux/ubuntu/dists/noble/InRelease) GET은 PGP 서명된 형식, 날짜 `2026-10-14 10:02:33 UTC`, `stable/binary-amd64/Packages` 470860 bytes와 SHA-256 `adf9ff9fa35b1c758b96b9a08543220f5e7ea41b79675fb5125283ae2ef5cab7`을 명시했다. 저장소 메타데이터는 갱신된다. 설치 시 고정한 키/fingerprint와 apt의 InRelease → Packages → deb 검증 경로를 사용하고 인증 우회 옵션을 금지하는 것은 DockSlate 설계 선택이다. 이번 조사에서 GPG 서명 검증이나 apt 설치를 실행하지 않았다.

Docker 문서는 iptables-nft와 iptables-legacy를 지원한다고 명시한다. 독자 nft 규칙 작성과 Docker의 포트 게시에 대한 ufw 차단을 동일하게 취급하면 안 된다. [정적 바이너리 안내](https://docs.docker.com/engine/install/binaries/)도 iptables 등 OS 전제조건과 수동 업데이트를 요구한다. 공식 정적 tar 목록에는 Docker 29.8.2가 있지만 독립 런타임은 OS 의존성 검증과 설치를 포함하는 apt 경로를 기준으로 삼는다. 정적 tar의 공식 SHA-256은 이번 조사에서 확보하지 않았다.

## WSL 운영 제약과 DockSlate 설계 선택

- **공식 사실:** [Microsoft systemd 안내](https://learn.microsoft.com/windows/wsl/systemd)는 WSL 0.67.6 이상, `/etc/wsl.conf`의 `[boot] systemd=true`, Debian/Ubuntu의 systemd-sysv 설치를 설명한다. systemd 서비스만으로 WSL 인스턴스를 계속 살아 있게 할 수 없다고 명시한다.
- **공식 사실:** [WSL 설정 안내](https://learn.microsoft.com/windows/wsl/wsl-config)는 `/etc/wsl.conf`가 배포판별 설정이고 `wsl --terminate <distroName>`이 특정 배포판만 종료한다고 설명한다. `.wslconfig`는 전체 WSL2 VM에 영향을 준다. `--shutdown`은 전체 배포판과 VM을 종료한다.
- **독자 설계:** 고정 이름 `DockSlate`와 Windows 환경에서 결정한 전용 저장 위치를 소유한 배포판을 만들고, Rust가 그 배포판의 Linux Unix socket만 제한된 명령으로 사용한다. Docker Desktop/Rancher Desktop, Windows에 남은 docker.exe/context에 의존하지 않는다. 기존 Docker 데이터의 자동 이관은 이 경로에 포함하지 않는다.
- **독자 설계:** 시작 상태에는 WSL 유지 프로세스와 실제 Moby API 응답 확인이 필요하다. stopped 상태 조회는 registry/`wsl --list --verbose` 등으로 수행해야 한다. `wsl -d DockSlate` 안에서 조회하면 정지 배포판을 시작할 수 있다. 종료는 전용 서비스 정지 후 소유 배포판만 대상으로 한다.
- **공식 사실:** [WSL 네트워크 안내](https://learn.microsoft.com/windows/wsl/networking)는 기본 NAT에서 Windows의 localhost로 Linux 서비스를 접근할 수 있다고 설명한다. [WSL 설정](https://learn.microsoft.com/windows/wsl/wsl-config)의 `localhostForwarding` 기본값은 true이고 mirrored에서는 무시된다. mirrored는 Windows 11 22H2 이상에서 제공되며 방화벽·VPN·포트 충돌에 영향을 받는다.
- **공식 사실/미검증:** [Docker 포트 게시](https://docs.docker.com/engine/network/port-publishing/)에서 IP를 생략하면 호스트 전체 주소에 게시되고 `127.0.0.1`을 지정하면 호스트 loopback에 한정된다. 이 Docker host는 Linux WSL 배포판이다. 해당 고정 엔진의 게시 포트를 Windows localhost에서 접근하는 실측은 하지 않았다. 임의 고정 API TCP 포트나 전역 방화벽·네트워크 설정 변경을 요구하는 설계는 채택하지 않는다.
- **공식 사실:** [Docker bind mount](https://docs.docker.com/engine/storage/bind-mounts/)의 source는 클라이언트가 아닌 daemon host 경로다. [Microsoft 파일 시스템 안내](https://learn.microsoft.com/windows/wsl/filesystems)는 Linux 경로 전달과 Linux 파일 시스템의 성능 이점을 설명한다. Windows 고정 드라이브는 기본적으로 `/mnt/<drive>`에 DrvFs로 표시되지만 설정·권한에 따라 다르다. Windows 문자열 경로 자동 변환이나 Docker Desktop 파일 공유 기능이 있다고 가정하지 않는다. Windows bind mount, 파일 감시, 권한·대소문자 동작은 미검증이다.

## 라이선스와 미확인 사항

[Moby](https://github.com/moby/moby/blob/master/LICENSE), [Docker CLI v29.8.2](https://github.com/docker/cli/blob/v29.8.2/LICENSE), [containerd v2.3.6](https://github.com/containerd/containerd/blob/v2.3.6/LICENSE), [runc](https://github.com/opencontainers/runc/blob/main/LICENSE)의 공식 LICENSE는 Apache-2.0이다. 바이너리와 종속 라이브러리의 고지는 각 패키지 원문을 보존해야 하며, 이번 조사에서 deb 내부 전체 라이선스 감사를 완료하지 않았다.

[Canonical 정책](https://canonical.com/legal/intellectual-property-policy)은 Ubuntu를 개별 라이선스가 적용되는 여러 패키지의 집합으로 설명하고 개인/조직 내부 사용을 허용한다. Ubuntu 전체를 Apache-2.0으로 표시할 수 없다. DockSlate가 공식 원본 이미지를 다운로드한 뒤 로컬 전용 배포판에 설정하는 방식과 수정한 Ubuntu 이미지를 외부 재배포하는 방식은 구분해야 한다. 공개 배포물의 패키지별 고지와 Ubuntu 상표 요건은 아직 확정하지 않았다. 기존 Rancher Apache-2.0/Dockhand BSL 1.1 구분은 유지한다.

실제 rootfs import, 설치 스크립트, apt 서명 검증, 서비스 시작/유지/정지, Moby 엔진 연결, 게시 포트, Windows bind mount, 디스크 경로·회수량은 미검증이다. Docker Desktop 제거나 기존 데이터 변경을 수행하지 않았으므로 제거 후 E2E 통과를 주장하지 않는다.

## 2026-10-15 실제 구현에서 추가 확인

위 미검증 표시는 10월 14일 입력 조사 시점의 상태다. 이후 사용자가 전용 엔진 설치·검증과 Docker Desktop 제거·소유 VHDX 삭제를 승인했다. 사용자 지정 `D:\Program Files\DockSlate\runtime\wsl`에 실제 rootfs import와 서명·고정 해시 검증을 포함한 패키지 설치를 수행했고 Moby 29.8.2 / API 1.55 연결을 확인했다. [설치·연결 결과](independent-runtime-provisioning.json), [제거 전 실제 E2E](independent-engine-e2e-before-desktop-removal.json), [공식 제거기·VHDX 결과](docker-desktop-removal.json)에 실행 사실을 분리했다. 새 REA 관찰은 아니다.

실제 `/v1.55/system/df`는 기존 필드와 `ImageUsage`, `ContainerUsage`, `VolumeUsage`, `BuildCacheUsage`를 함께 반환했다. [실제 응답](owned-docker-df-raw.json)과 Docker CLI를 대조했다. 공개 현재 master의 [system 응답 타입](https://github.com/moby/moby/blob/master/api/types/system/disk_usage.go), [image 집계 타입](https://github.com/moby/moby/blob/master/api/types/image/disk_usage.go), [container 집계 타입](https://github.com/moby/moby/blob/master/api/types/container/disk_usage.go)은 집계 `TotalSize` 등 0값의 `omitempty`를 명시한다. 설치 버전의 정확한 소스 태그는 이번 조회에서 확보하지 못했으므로 현재 master와 동일한 구현이라고 단정하지 않는다. DockSlate는 실제 집계 객체가 있을 때 생략된 크기를 0으로 읽고, 음수·잘못된 값은 미확인으로 유지하며, 기존 API 필드는 집계 객체가 없을 때 사용한다.
