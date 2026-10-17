import { engineLabel, type EngineProps } from '../App';
import { ErrorNotice, PageHeader, RefreshButton, StatusBadge } from '../components';
import { RuntimePanel, useDockSlateRuntime } from '../runtime';
import { defaultAppearance, useAppearance } from '../appearance';

export default function Settings(props: EngineProps & { runtime: ReturnType<typeof useDockSlateRuntime> }) {
  const engine = props.engine;
  const runtime = props.runtime;
  const refresh = props.reloadEngine;
  const { appearance, setAppearance } = useAppearance();
  return <>
    <PageHeader title="Settings"><RefreshButton busy={props.engineLoading || runtime.query.loading || runtime.preparing} onClick={() => void refresh()} /></PageHeader>
    <section className="settings-panel appearance-panel" aria-label="화면 설정">
      <h2>화면</h2>
      <div className="appearance-row"><span>테마</span><div className="segmented" role="group" aria-label="테마 선택">{(['dark', 'light'] as const).map(theme => <button key={theme} className={appearance.theme === theme ? 'active' : ''} aria-pressed={appearance.theme === theme} onClick={() => setAppearance(value => ({ ...value, theme }))}>{theme === 'dark' ? '다크' : '라이트'}</button>)}</div></div>
      <div className="appearance-row"><span>글자 크기</span><div className="font-size-controls"><button className="button small" aria-label="글자 작게" disabled={appearance.fontSize <= 11} onClick={() => setAppearance(value => ({ ...value, fontSize: value.fontSize - 1 }))}>A−</button><output aria-label="글자 크기" aria-live="polite">{appearance.fontSize}px</output><button className="button small" aria-label="글자 크게" disabled={appearance.fontSize >= 16} onClick={() => setAppearance(value => ({ ...value, fontSize: value.fontSize + 1 }))}>A+</button><button className="button small subtle" onClick={() => setAppearance(value => ({ ...value, fontSize: defaultAppearance.fontSize }))}>기본값</button></div></div>
    </section>
    <RuntimePanel runtime={runtime} />
    {props.engineError && <ErrorNotice message={props.engineError} onRetry={() => void props.reloadEngine()} />}
    <details className="settings-panel engine-details"><summary>엔진 연결 정보</summary>
      <dl className="settings-properties">
        <dt>연결 상태</dt><dd><StatusBadge tone={engine?.state === 'connected' ? 'success' : engine?.state === 'permission_denied' ? 'danger' : 'warning'}>{engineLabel(engine, props.engineLoading)}</StatusBadge></dd>
        <dt>연결 대상</dt><dd>{engine?.context ?? '미확인'}</dd><dt>엔진 종류</dt><dd>{engine?.engine ?? '미확인'}</dd>
        <dt>서버 버전</dt><dd>{engine?.serverVersion ?? '미확인'}</dd><dt>API 버전</dt><dd>{engine?.apiVersion ?? '미확인'}</dd>
        <dt>Endpoint</dt><dd className="mono">{engine?.endpoint ?? '미확인'}</dd><dt>런타임 확인 경로</dt><dd className="mono">{engine?.ownerPath ?? '미확인'}</dd>
        <dt>진단</dt><dd>{engine?.message ?? (props.engineLoading ? '연결 정보를 확인하고 있습니다.' : props.engineError ?? '엔진 정보를 읽지 못했습니다.')}</dd>
      </dl>
    </details>
  </>;
}
