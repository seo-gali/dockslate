# Dockerfile·Compose 직접 실행 예제

이 폴더의 파일은 사용자가 직접 선택하고 실행하는 예제입니다. 파일을 열거나 앱을 빌드해도 컨테이너가 자동 생성되지 않습니다.

1. DockSlate의 **빌드 → 파일에서 빌드 → Dockerfile 선택**에서 이 폴더의 `Dockerfile`을 선택합니다. 빌드를 확인하고 실행하면 로컬 이미지가 만들어집니다.
2. **Compose 파일 선택**에서 이 폴더의 `compose.yaml`을 선택합니다. 빌드 후 서비스·포트·볼륨을 확인하고 별도로 실행을 승인합니다.
3. 실행 후 [http://127.0.0.1:18080](http://127.0.0.1:18080)에 접속하면 `DockSlate Dockerfile / Compose OK`가 표시됩니다.

DockSlate에서 가져온 Compose는 충돌을 피하도록 프로젝트·이미지 이름을 `dockslate-import-…`로 바꿉니다. `18080` 포트가 사용 중이면 기존 예제 컨테이너를 확인하거나 실행 전에 이 파일의 호스트 포트를 바꾸세요.

CLI로 실행하려면 이 폴더에서 `docker compose up --build -d`를 실행합니다. 종료는 `docker compose down`이며, 이 명령은 예제의 볼륨을 보존합니다. `/data/check.txt`는 볼륨 연결 확인용입니다.
