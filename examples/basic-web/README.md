# Node.js Dockerfile·Compose 예제

Node.js 24 Alpine 기반 웹 앱입니다. 별도 npm 패키지 없이 실행하며, 일반 사용자 실행·환경 변수·상태 검사·로그 크기 제한을 포함합니다. 컨테이너 생성과 실행은 사용자가 진행합니다.

`Dockerfile`, `compose.yaml`, `server.mjs`, `.dockerignore`를 같은 폴더에 두세요. `.dockerignore`는 설치 EXE·ZIP 등 불필요한 파일이 빌드 컨텍스트에 들어가지 않게 합니다. 최초 빌드에는 공식 Node.js 이미지 다운로드가 필요합니다.

1. DockSlate의 **빌드 → 파일에서 빌드 → Dockerfile 선택**에서 이 폴더의 `Dockerfile`을 선택합니다. 빌드를 확인하고 실행하면 로컬 이미지가 만들어집니다.
2. **Compose 파일 선택**에서 이 폴더의 `compose.yaml`을 선택합니다. 빌드 후 서비스·포트·볼륨을 확인하고 별도로 실행을 승인합니다.
3. 실행 후 [http://127.0.0.1:18080](http://127.0.0.1:18080)에 접속하면 앱 이름과 Node.js 버전이 표시됩니다. `/health`는 `{"status":"ok"}`를 반환합니다.

DockSlate에서 가져온 Compose는 충돌을 피하도록 프로젝트·이미지 이름을 `dockslate-import-…`로 바꿉니다. `18080` 포트가 사용 중이면 기존 예제 컨테이너를 확인하거나 실행 전에 이 파일의 호스트 포트를 바꾸세요.

CLI로 실행하려면 이 폴더에서 다음 명령을 실행합니다.

```powershell
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail 50
```

종료는 `docker compose down`입니다. 이 예제는 볼륨을 만들지 않으며, 이전 예제의 볼륨을 삭제하지 않습니다. `unless-stopped`는 사용자가 중지하기 전까지 컨테이너 오류나 엔진 재시작 시 다시 시작하도록 설정합니다.

구성 참고: [Docker의 Node.js 가이드](https://docs.docker.com/guides/nodejs/), [공식 Node.js 이미지 권장 사항](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md).
