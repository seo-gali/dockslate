# DockSlate 사용 안내

## 시작과 화면 설정

Settings에서 DockSlate 런타임을 설치하고 시작한다. 설치와 시작은 별도 승인 작업이다. 이미 설치한 배포판과 저장소는 덮어쓰지 않는다.

앱을 열면 목록을 함께 읽는다. 메뉴 이동은 저장된 결과를 사용하고, **전체 새로고침**은 모든 메뉴를 갱신한다. 생성·삭제 같은 작업이 끝난 뒤에도 결과를 갱신한다. 열린 로그·터미널과 진행 중인 작업만 필요한 갱신을 수행한다.

Settings의 **화면**에서 다크·라이트 테마와 글자 크기(11~16px, 기본 12px)를 선택한다. 선택은 같은 Windows 사용자·앱 프로필에 저장된다. 엔진 설정에는 영향을 주지 않는다.

## 이미지에서 컨테이너 실행

1. Images에서 Docker Hub 이미지를 검색하고 선택한다. 검색·Pull에는 실행 중인 DockSlate 엔진과 인터넷 연결이 필요하다.
2. 필요한 태그로 Pull한다. 로컬 이미지의 **실행**을 누른다.
3. 이름과 포트를 입력한다. **더보기**에서 명령, 환경 변수, 볼륨·bind mount, 네트워크, 재시작 정책, CPU·메모리 제한 등을 지정한다.
4. 생성 후 Containers에서 확인한다. 명령이 끝나는 이미지(`hello-world` 등)는 정상 실행 후 중지될 수 있다.

이미지 빌드는 Builds의 **이미지 빌드**에서 Dockerfile과 소스가 있는 폴더, Dockerfile 경로, 이미지 이름·태그를 지정한다. `.dockerignore`가 적용된다. 같은 태그는 새 결과를 가리키게 된다. 현재 앱 자체 빌드는 한 번에 하나이며 메뉴를 옮겨도 계속된다.

## 컨테이너

이름을 누르면 중앙 팝업이 열린다. 닫기 버튼이나 Escape로 닫는다.

| 탭 | 용도 |
| --- | --- |
| Details | 상태·이미지·포트와 시작·중지·삭제 |
| Logs | 최근 로그, 검색·복사·자동 스크롤 |
| Inspect / Mounts | 실제 Docker 설정 JSON과 연결한 저장소 |
| Terminal | 실행 중인 컨테이너의 대화형 셸 |
| Files | 폴더 탐색과 텍스트 미리보기 |
| Stats | CPU·메모리와 선택한 실시간 측정 |

실시간 통계는 해당 화면이 열려 있을 때만 갱신한다. CPU 100%는 코어 하나에 해당하며 메모리는 Linux 파일 캐시를 보정한 값이다. 링크와 특수 파일은 열지 않는다. 중지된 컨테이너 파일 조회는 Docker archive API의 16MiB 제한이 있으므로 큰 폴더 대신 작은 경로를 선택한다.

행의 재생·중지 버튼과 더보기 메뉴에서 일시정지, 로그·Inspect·터미널·파일 열기, 실행 명령 복사, 게시된 TCP 포트의 브라우저 열기를 사용할 수 있다.

## 볼륨

Volumes에서 생성·복제·파일 보기·tar 내보내기/가져오기·비우기·삭제를 수행한다. 이름은 영문·숫자로 시작하고 이후 영문·숫자·밑줄·하이픈·마침표를 사용한다.

- 복제와 내보내기는 실행 중인 참조가 없어야 한다.
- 비우기·가져오기·삭제는 중지된 컨테이너의 참조도 해제해야 한다.
- 병합은 같은 경로의 파일을 덮어쓰고 나머지 파일을 유지한다. 전체 교체는 기존 내용을 삭제한다. 승인창에서 영향과 덮어쓸 경로를 확인한다.
- 옵션 없는 local 드라이버, 2GiB·50,000개 항목까지 지원한다. 텍스트는 UTF-8 64KiB까지 미리 본다. 작업 도중 실패하거나 외부에서 참조가 생기면 일부 변경이 남을 수 있다.

## 빌드 기록과 빌더

Builds에는 진행 중·빌드 기록·빌더·가져온 기록 탭이 있다. 다른 프로그램이 실행한 작업은 마지막 조회 결과이며 전체 새로고침으로 갱신한다. 이름을 누르면 설정과 로그를 본다.

사용자 빌더는 생성·선택·플랫폼 변경·등록 삭제가 가능하다. 선택은 현재 앱 실행에 적용되며 재실행하면 검증된 로컬 기본 빌더를 사용한다. 원격 빌더로 빌드하면 소스가 해당 서버로 전송되므로 승인창의 대상을 확인한다. 원격 TLS·SSH·Kubernetes 구성은 현재 지원 범위가 아니다.

`.dockerbuild` 가져오기는 기록·로그 보관 기능이다. 이미지나 캐시를 복원하지 않는다. 입력 64MiB·압축 해제 128MiB·처리 15초 제한이 있다. 엔진이 꺼져 있어도 가져온 로컬 기록은 볼 수 있다.

## Compose와 deployment.yaml

파일 이름이 `deployment.yaml`이어도 내용이 **Compose 형식**이면 다음처럼 전체 서비스 이미지를 빌드할 수 있다. 경로는 WSL에서 보이는 경로로 지정한다.

```powershell
wsl --distribution DockSlate --user root --exec docker --host unix:///var/run/docker.sock compose -f /mnt/d/my-project/deployment.yaml build
```

`build`를 가진 서비스만 빌드한다. 실제 서비스 실행·교체가 필요하면 프로젝트의 포트·볼륨·환경 설정을 검토한 뒤 Compose의 `up --build -d`를 별도로 실행한다. DockSlate UI의 Compose 기능은 프로젝트별 그룹 표시이며 Compose 편집·배포 버튼은 없다.

2026-10-18 전용 엔진의 Compose v5.6.0으로 격리한 두 서비스의 실제 빌드를 확인했다. 테스트 이미지·기록·새 캐시는 제거했고 기존 컨테이너·이미지·기록·캐시는 보존했다. [결과](docs/results/compose-e2e.json). 사용자의 실제 프로젝트 파일은 제공되지 않아 해당 프로젝트 전체의 빌드 성공까지 확인한 것은 아니다.

Kubernetes의 `kind: Deployment` 형식은 만들어진 이미지를 실행하는 선언이다. Dockerfile 빌드 절차가 아니며 DockSlate는 Kubernetes 배포를 지원하지 않는다. DockSlate Windows EXE 자체는 Windows의 Rust MSVC·Tauri 빌드 절차로 만든다.

공식 설명: [Compose Build](https://docs.docker.com/reference/compose-file/build/), [Kubernetes Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/).

## 앱 종료·재설치와 WSL 데이터

현재 배포물은 별도 Windows 설치기가 없는 EXE다. UI를 닫아도 실행 중인 DockSlate 엔진은 유지된다. 엔진을 중지하려면 Settings에서 런타임 중지를 승인한다.

EXE 삭제·교체는 DockSlate WSL 배포판을 등록 해제하거나 저장소를 지우지 않는다. 실행 파일과 WSL의 컨테이너·이미지·볼륨은 별도다. 재실행 시 기존 소유권과 등록 정보를 확인하며, 같은 이름의 배포판이나 기존 저장소를 새 설치 대상으로 덮어쓰지 않는다. 기존 데이터가 있는데 소유권 검증에 실패하면 진단을 확인하고 파일을 임의 삭제하지 않는다.

WSL 배포판 등록 해제는 그 배포판의 데이터를 지우는 별도 작업이다. 앱은 이를 자동으로 실행하지 않는다. 향후 설치기·제거기가 추가되면 그때의 데이터 보존 정책을 별도로 확인해야 한다.

## 저장 공간

Disk Manager의 Docker 정리 추정치, VHDX 크기, Windows 실제 회수량은 서로 다르다. 미사용 이미지·캐시는 대상을 선택하고 승인해서 정리한다. 의존 관계가 있는 캐시는 하위 캐시를 먼저 정리해야 할 수 있다.

VHDX 압축은 백업을 자동으로 만들지 않고 원본을 변경한다. 런타임 종료·소유권·디스크 분리·파일 잠금·관리자 권한을 검사하고 별도로 승인한다. 확인하지 못한 조건이 있으면 차단한다. 실제 압축 성공은 이번 검증에 포함하지 않았다.

## I/O 성능

Apple의 컨테이너 가상화는 macOS·Apple silicon용이며 Windows의 WSL 엔진에 그대로 이식할 수 없다. Davit에서는 간결한 데이터 중심 화면과 불필요한 프로세스 실행을 줄이는 접근을 참고했다. 코드·에셋을 가져오지는 않았다. 이 프로젝트는 기존 Tauri와 공유 조회 결과를 유지한다.

WSL의 파일 I/O는 소스가 Windows 마운트(`/mnt/c`, `/mnt/d`)에 있는지 Linux 파일 시스템에 있는지에 따라 달라진다. Linux 도구의 많은 작은 파일 작업은 Linux 파일 시스템을 사용하는 방식을 먼저 비교한다. 현재 UI 빌드 폴더 선택은 Windows 경로 기반이므로 Linux 경로 빌드 지원까지 구현했다고 보아서는 안 된다. [Microsoft 파일 시스템 안내](https://learn.microsoft.com/en-us/windows/wsl/filesystems), [Davit](https://github.com/wouterdebie/davit), [Apple container](https://github.com/apple/container).
