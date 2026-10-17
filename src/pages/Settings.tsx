import { engineLabel, type EngineProps } from '../App';
import { ErrorNotice, Icon, PageHeader, RefreshButton, StatusBadge } from '../components';
import { RuntimePanel, useDockSlateRuntime } from '../runtime';

export default function Settings(props: EngineProps & { runtime: ReturnType<typeof useDockSlateRuntime> }) {
  const engine = props.engine;
  const runtime = props.runtime;
  const refresh = props.reloadEngine;
  return <>
    <PageHeader title="Settings" description="DockSlate 엔진을 설치·시작·중지하고 현재 연결 상태를 확인합니다."><RefreshButton busy={props.engineLoading || runtime.query.loading || runtime.preparing} onClick={() => void refresh()} /></PageHeader>
    <RuntimePanel runtime={runtime} />
    {props.engineError && <ErrorNotice message={props.engineError} onRetry={() => void props.reloadEngine()} />}
    <div className="settings-grid">
      <section className="settings-panel"><h2>엔진 연결</h2><dl className="settings-properties">
        <dt>연결 상태</dt><dd><StatusBadge tone={engine?.state === 'connected' ? 'success' : engine?.state === 'permission_denied' ? 'danger' : 'warning'}>{engineLabel(engine, props.engineLoading)}</StatusBadge></dd>
        <dt>연결 대상</dt><dd>{engine?.context ?? '미확인'}</dd><dt>엔진 종류</dt><dd>{engine?.engine ?? '미확인'}</dd>
        <dt>서버 버전</dt><dd>{engine?.serverVersion ?? '미확인'}</dd><dt>API 버전</dt><dd>{engine?.apiVersion ?? '미확인'}</dd>
        <dt>Endpoint</dt><dd className="mono">{engine?.endpoint ?? '미확인'}</dd><dt>런타임 확인 경로</dt><dd className="mono">{engine?.ownerPath ?? '미확인'}</dd>
        <dt>진단</dt><dd>{engine?.message ?? (props.engineLoading ? '연결 정보를 확인하고 있습니다.' : props.engineError ?? '엔진 정보를 읽지 못했습니다.')}</dd>
      </dl></section>
      <section className="settings-panel"><h2>환경 및 권한</h2><div className="settings-help">
        <div><h3>DockSlate · Moby</h3><p>DockSlate 런타임을 설치한 뒤 시작하면 전용 엔진에 연결합니다. 컨테이너·이미지·볼륨은 새 DockSlate 저장소에 생성됩니다.</p></div>
        <div><h3>엔진 연결 확인</h3><p>컨테이너 작업과 엔진 연결은 DockSlate 백엔드가 처리합니다. 연결 실패 시 진단 내용을 확인하고 새로고침하세요.</p></div>
        <div><h3>WSL 디스크 압축</h3><p>검증된 WSL 등록 정보, 런타임 종료, 디스크 분리 및 관리자 권한이 필요합니다. 백업 없이 압축하면 실패 시 복구할 수 없으며, 대상을 확인하고 별도로 승인한 뒤 실행합니다.</p></div>
      </div></section>
    </div>
    <div className="notice info" style={{ marginTop: 18 }}><Icon name="check" /><div><strong>전체 새로고침은 읽기 전용입니다</strong><p>모든 메뉴의 연결 상태·목록·사용량·WSL 디스크를 함께 갱신합니다. 런타임 설치·시작·중지는 각 작업의 대상과 영향을 확인하고 승인한 뒤에만 실행됩니다.</p></div></div>
  </>;
}
