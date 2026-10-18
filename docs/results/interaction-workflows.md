# Pull·실행·로그·접속 주소 검증

2026-10-18. 최신 EXE `A746B364F516DC39B05A65D47FBE727B57F27CD4D35CD068F5ABF02D149F8A02`에서 확인했다.

| 변경 | 실제 확인 |
| --- | --- |
| Pull 진행·완료 팝업 | 기존 hello-world의 고정 digest를 실제 Pull. 진행 바·완료·닫기 확인 |
| 실행 폼 | 선택한 실제 이미지 행 바로 아래 펼침 |
| 생성 후 이동 | 격리 hello-world 컨테이너 생성 → 목록의 새 행 표시. 상세·로그 팝업 자동 열림 없음 |
| 표 너비 | 실제 네이티브 화면에서 구분선·드래그·저장 확인. 별도 브라우저에서 키보드·취소·초기화·재로드도 확인 |
| 포트 | Mongo 주소 복사, 브라우저 메뉴 비활성화, 백엔드의 DB 포트 열기 거절 |
| 로그 | Docker follow 연결과 Tauri 이벤트로 초기 tail·새 내용 전달. 2초 전체 조회 없음. 숨김·닫기에서 종료 |
| 상세 | 통계를 합친 한국어 6개 탭, 같은 팝업 크기, 로그 안쪽 여백 확인 |

## 결과 파일

- [네이티브 조작 9개](interactions-native-e2e.json): 실제 Docker API·화면, 모의 백엔드 없음.
- [네이티브 로그 이벤트 13개](live-log-native-e2e.json): 순서·reset·32KiB 제한·취소·오류 차단. 원문 로그 저장 없음.
- [네이티브 로그·상세 화면 5개](log-ui-native-e2e.json): 실제 Mongo 로그, 유휴 전체 재조회 없음, 탭 크기·여백.
- [열 조절 브라우저 검사 10개](table-columns-e2e.json): 제품 컴포넌트와 같은 7개 열, 빈 표. 엔진 데이터·백엔드 주입 없음. 드래그 중 부모 렌더 횟수 2→2.
- [실제 로그 보조 연결](live-log-helper-e2e.json): 첫 수신165ms, 무음22초 유지, EOF 취소24ms. Tauri 시작 전체 시간과 구분한다.

네이티브 초기 로그 이벤트는 엔진 검증을 포함해 첫 연결1,758ms·재연결828ms였다. 첫 프레임 이후에는 새 로그 이벤트를 받으며 전체 로그를 반복 요청하지 않는다. 전체 앱의 성능 보장값은 아니다.

## MongoDB와 CLI

- 실제 컨테이너 `trusting_feistel`은 실행 중이며 `127.0.0.1:32768 → 27017/tcp`다.
- Windows에서 TCP32768 연결 성공, TCP27017 연결 거절을 확인했다. Compass에는 `mongodb://127.0.0.1:32768/`를 사용한다.
- Compass의 인증·데이터 조회는 실행하지 않았다. 기존 MongoDB 데이터는 변경하지 않았다.
- Windows의 `docker` 명령은 발견되지 않았지만 전용 WSL Docker의 `ps`·포트 조회는 성공했다. Windows CLI·PATH를 추가 설치하거나 변경하지 않았다.

```text
wsl -d DockSlate -u root --exec /usr/bin/docker --host unix:///var/run/docker.sock ps
```

MongoDB 포트는 일반 TCP 클라이언트 연결용이다. 브라우저 열기는 검증된 컨테이너의 루프백 포트에서 HTTP/HTTPS 응답을 확인한 뒤 수행한다. [MongoDB 프로토콜 문서](https://www.mongodb.com/docs/manual/reference/mongodb-wire-protocol/)

## 보존·보안

테스트용 hello-world 컨테이너 1개만 만들고 정확한 ID를 승인해 삭제했다. 전후 컨테이너·이미지·볼륨·네트워크 집합을 비교했고 기존 MongoDB의 실행 상태를 확인했다. 테스트 앱은 정상 창 닫기로 종료했다. WSL 중지·보안 예외 등록·원문 로그 저장은 하지 않았다.

자동 승인 검토가 최초 실행을 거부했다. 서명 부재와 미해결 브라우징 데이터 경고를 설명한 뒤 사용자가 지정 EXE의 실행을 명시적으로 허용했다. 새 작업 프로필에서 검증했으며 **경고의 원인이나 악성 여부가 해결된 것은 아니다**.

캐시 이미지 Pull·연쇄 삭제·Compose 가져오기는 서로 다른 경로다. 이번 검증으로 임의의 새 이미지 다운로드, Compose 전체 경로, 실제 VHDX 압축까지 통과했다고 표시하지 않는다.
