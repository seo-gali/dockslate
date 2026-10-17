import { useEffect, useRef, useState } from 'react';
import { backend, refreshDashboardAfterMutation, useBackendQuery } from './api';
import { OperationNotice, type Operation } from './actions';
import { ConfirmDialog, ErrorNotice, Icon, StatePanel, StatusBadge, errorMessage } from './components';

export type RuntimeState = 'not_installed' | 'stopped' | 'running' | 'installing' | 'starting' | 'stopping' | 'failed' | 'unsupported';
export interface RuntimeStatus {
  state: RuntimeState;
  distribution: string;
  installPath: string | null;
  message: string;
  blockedReasons: string[];
  operation?: { state: string; message: string; processId?: number; startedAt?: number } | null;
}
export interface RuntimeInstallPreview {
  token: string | null;
  targets: string[];
  impact: string[];
  requirements: string[];
  eligible: boolean;
  blockedReasons: string[];
  expiresAt: number | null;
}
interface RuntimeResult { state: RuntimeState; message: string }
type RuntimeAction = 'install' | 'start' | 'stop';

const stateLabels: Record<RuntimeState, string> = {
  not_installed: '미설치', stopped: '중지됨', running: '실행 중', installing: '설치 중',
  starting: '시작 중', stopping: '중지 중', failed: '실패', unsupported: '사용 불가',
};
const actionLabels: Record<RuntimeAction, string> = { install: '설치', start: '시작', stop: '중지' };
const isWorking = (state?: RuntimeState) => state === 'installing' || state === 'starting' || state === 'stopping';
const statusMessages: Partial<Record<RuntimeState, string>> = {
  not_installed: 'DockSlate 전용 런타임이 설치되지 않았습니다.',
  stopped: 'DockSlate 엔진이 중지되었습니다. 시작 버튼으로 다시 실행할 수 있습니다.',
  running: 'DockSlate 전용 배포판이 실행 중입니다. 엔진 연결 상태는 아래에서 확인하세요.',
  installing: 'DockSlate 전용 런타임을 설치하고 있습니다.',
  starting: 'DockSlate 전용 엔진을 시작하고 있습니다.',
  stopping: 'DockSlate 전용 엔진과 배포판을 중지하고 있습니다.',
};

export function useDockSlateRuntime(externalBusy = false) {
  const query = useBackendQuery<RuntimeStatus>('runtime_status');
  const [preparing, setPreparing] = useState(false);
  const [pending, setPending] = useState<RuntimeAction | null>(null);
  const [tracking, setTracking] = useState<RuntimeAction | null>(null);
  const [confirmation, setConfirmation] = useState<RuntimeAction | null>(null);
  const [preview, setPreview] = useState<RuntimeInstallPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation>(null);
  const requestInFlight = useRef(false);
  const previousState = useRef<RuntimeState | undefined>(undefined);
  const previousRevision = useRef(query.revision);
  const busy = pending !== null || tracking !== null || isWorking(query.data?.state);
  const controlsDisabled = externalBusy || busy || preparing || query.loading || !query.data || confirmation !== null;

  useEffect(() => {
    const state = query.data?.state;
    if (!state) return;
    if (isWorking(previousState.current) && !isWorking(state) && previousRevision.current === query.revision) void refreshDashboardAfterMutation();
    previousState.current = state;
    previousRevision.current = query.revision;
  }, [query.data?.state, query.revision]);
  useEffect(() => {
    if (query.loading || !busy) return;
    const timer = window.setTimeout(() => void query.poll(), 1000);
    return () => window.clearTimeout(timer);
  }, [busy, query.loading, query.poll]);
  useEffect(() => {
    if (!tracking || pending || query.loading || !query.data || isWorking(query.data.state)) return;
    const failed = query.data.state === 'failed' || query.data.state === 'unsupported' || query.data.state === 'not_installed' || query.data.operation?.state === 'failed';
    setOperation(failed ? { tone: 'danger', message: query.data.operation?.message ?? query.data.message } : null);
    setTracking(null);
  }, [tracking, pending, query.loading, query.data]);

  const prepareInstall = async () => {
    if (requestInFlight.current || controlsDisabled || query.data?.state !== 'not_installed') return;
    requestInFlight.current = true;
    setPreparing(true);
    setPreview(null);
    setDialogError(null);
    setOperation({ tone: 'accent', message: '설치 대상과 필요한 환경을 확인하고 있습니다…' });
    try {
      const value = await backend<RuntimeInstallPreview>('runtime_install_preview');
      setPreview(value);
      setAcknowledged(false);
      if (value.eligible && value.token) {
        setConfirmation('install');
        setOperation(null);
      } else {
        setOperation({ tone: 'danger', message: '설치 조건을 충족하지 못했습니다. 아래 차단 사유를 확인하세요.' });
      }
    } catch (failure) {
      setOperation({ tone: 'danger', message: `설치 조건 확인 실패: ${errorMessage(failure)}` });
    } finally {
      setPreparing(false);
      requestInFlight.current = false;
    }
  };

  const requestAction = (action: 'start' | 'stop') => {
    if (requestInFlight.current || controlsDisabled || query.data?.blockedReasons.length) return;
    if (query.data?.state !== (action === 'start' ? 'stopped' : 'running')) return;
    setConfirmation(action);
    setAcknowledged(false);
    setDialogError(null);
  };

  const cancel = () => {
    if (pending) return;
    setConfirmation(null);
    setAcknowledged(false);
    setDialogError(null);
  };

  const execute = async () => {
    if (!confirmation || !acknowledged || busy || requestInFlight.current) return;
    if (confirmation === 'install' && (!preview?.eligible || !preview.token)) return;
    if (confirmation === 'install' && preview?.expiresAt != null && preview.expiresAt <= Date.now()) {
      setDialogError('설치 확인 정보가 만료되었습니다. 취소한 뒤 설치 조건을 다시 확인하세요.');
      setAcknowledged(false);
      return;
    }
    const action = confirmation;
    requestInFlight.current = true;
    setPending(action);
    setDialogError(null);
    setOperation({ tone: 'accent', message: `DockSlate 런타임 ${actionLabels[action]} 요청을 처리하고 있습니다…` });
    try {
      const result = await backend<RuntimeResult>(`runtime_${action}`, action === 'install' ? { token: preview!.token, approved: true } : { approved: true });
      const failed = result.state === 'failed' || result.state === 'unsupported' || result.state === 'not_installed';
      setOperation(failed ? { tone: 'danger', message: result.message } : isWorking(result.state) ? { tone: 'accent', message: statusMessages[result.state] ?? `DockSlate 런타임 ${actionLabels[action]} 중입니다.` } : null);
      setTracking(isWorking(result.state) ? action : null);
      setConfirmation(null);
      setAcknowledged(false);
      setPreview(null);
    } catch (failure) {
      const message = `${actionLabels[action]} 실패: ${errorMessage(failure)}`;
      setDialogError(message);
      setOperation({ tone: 'danger', message });
      setAcknowledged(false);
    } finally {
      await refreshDashboardAfterMutation();
      setPending(null);
      requestInFlight.current = false;
    }
  };

  const dialog = confirmation && <ConfirmDialog
    title={`DockSlate 런타임 ${actionLabels[confirmation]} 확인`}
    label={confirmation === 'install' ? '설치 승인 및 실행' : `${actionLabels[confirmation]} 승인 및 실행`}
    busy={pending !== null}
    error={dialogError}
    acknowledged={acknowledged}
    onAcknowledge={setAcknowledged}
    onCancel={cancel}
    onConfirm={() => void execute()}
  >
    {confirmation === 'install' && preview ? <>
      <p>다음 대상을 새로 설치합니다.</p>
      <ul className="dialog-target-list">{preview.targets.map((target, index) => <li key={index}>{target}</li>)}</ul>
      {preview.impact.map((impact, index) => <p key={index}>{impact}</p>)}
      <p><strong>필요한 환경</strong></p>
      <ul className="dialog-target-list">{preview.requirements.map((requirement, index) => <li key={index}>{requirement}</li>)}</ul>
      <p>DockSlate 전용 WSL 배포판과 저장소에서 컨테이너·이미지·볼륨을 관리합니다. 기존 Docker 데이터는 자동으로 가져오지 않습니다.</p>
      {preview.expiresAt != null && <p>승인 정보 만료: {new Date(preview.expiresAt).toLocaleTimeString()}</p>}
    </> : confirmation === 'start' ? <>
      <ul className="dialog-target-list"><li>{query.data?.distribution} · Moby 엔진</li></ul>
      <p>DockSlate 배포판과 컨테이너 엔진을 시작합니다. 저장된 컨테이너는 재시작 정책에 따라 자동으로 실행될 수 있습니다.</p>
    </> : <>
      <ul className="dialog-target-list"><li>{query.data?.distribution} · Moby 엔진 · 이 엔진의 실행 중 컨테이너</li></ul>
      <p className="danger">실행 중인 컨테이너와 컨테이너에 연결된 서비스가 중단됩니다. 저장하지 않은 메모리 상태와 연결은 복구되지 않습니다.</p>
      <p>DockSlate 배포판을 중지합니다. 저장된 컨테이너·이미지·볼륨은 유지되며 다음 시작 시 다시 사용할 수 있습니다.</p>
    </>}
  </ConfirmDialog>;

  return { query, preparing, busy, controlsDisabled, preview, operation, setOperation, prepareInstall, requestAction, dialog };
}

export function RuntimePanel({ runtime }: { runtime: ReturnType<typeof useDockSlateRuntime> }) {
  const { query, preview } = runtime;
  const status = query.data;
  const blockers = preview && !preview.eligible && status?.state === 'not_installed' ? preview.blockedReasons : status?.blockedReasons ?? [];
  return <section className="settings-panel" style={{ marginBottom: 18 }} aria-busy={runtime.busy || runtime.preparing}>
    <h2>DockSlate 런타임</h2>
    <div className="settings-help">
      <OperationNotice operation={runtime.operation} onDismiss={() => runtime.setOperation(null)} />
      {query.error && <ErrorNotice message={query.error} onRetry={() => void query.reload()} />}
      {query.loading && !status ? <StatePanel busy icon="settings" title="런타임 상태 확인 중" description="DockSlate 배포판과 엔진의 현재 상태를 조회합니다." /> : status && <>
        <dl className="settings-properties" style={{ padding: 0 }}>
          <dt>런타임 상태</dt><dd><StatusBadge tone={status.state === 'running' ? 'success' : status.state === 'failed' ? 'danger' : isWorking(status.state) ? 'accent' : status.state === 'stopped' ? 'muted' : 'warning'}>{stateLabels[status.state]}</StatusBadge>{query.loading && <span className="muted" style={{ marginLeft: 10 }}>상태 갱신 중…</span>}</dd>
          <dt>WSL 배포판</dt><dd>{status.distribution}</dd>
          <dt>설치 위치</dt><dd className="mono">{status.installPath ?? (status.state === 'not_installed' ? '설치 전' : '미확인')}</dd>
          <dt>상태 안내</dt><dd>{statusMessages[status.state] ?? status.message}</dd>
          {status.operation && (status.operation.state === 'failed' || isWorking(status.state)) && <><dt>최근 작업</dt><dd>{status.operation.message}</dd></>}
        </dl>
        {statusMessages[status.state] && <details className="runtime-diagnostics"><summary>원본 런타임 진단</summary><p>{status.message}</p>{status.operation && <p>{status.operation.message}</p>}</details>}
        {blockers.length > 0 && <div><p><strong>작업 차단 사유</strong></p><ul className="disk-blockers" style={{ marginTop: 8 }}>{blockers.map((reason, index) => <li key={index}><Icon name="warning" size={14} /><span>{reason}</span></li>)}</ul></div>}
        <div className="detail-actions" style={{ marginTop: 0 }}>
          {status.state === 'not_installed' && <button className="button primary" disabled={runtime.controlsDisabled} onClick={() => void runtime.prepareInstall()}><Icon name="download" size={16} />{runtime.preparing ? '설치 조건 확인 중…' : '런타임 설치…'}</button>}
          {status.state === 'stopped' && <button className="button primary" disabled={runtime.controlsDisabled || blockers.length > 0} onClick={() => runtime.requestAction('start')}><Icon name="play" size={16} />런타임 시작…</button>}
          {status.state === 'running' && <button className="button" disabled={runtime.controlsDisabled || blockers.length > 0} onClick={() => runtime.requestAction('stop')}><Icon name="stop" size={16} />런타임 중지…</button>}
          {isWorking(status.state) && <span className="muted" role="status">{stateLabels[status.state]}… 완료 상태를 확인하고 있습니다.</span>}
          {status.state === 'failed' && <span className="muted">실패 원인을 해결한 뒤 상태를 새로고침하세요.</span>}
          {status.state === 'unsupported' && <span className="muted">필요한 환경을 확인한 뒤 상태를 새로고침하세요.</span>}
          {(status.state === 'running' || status.state === 'stopped') && <span className="muted" style={{ fontSize: '0.923077rem' }}>{status.state === 'running' ? '중지하면 이 엔진의 컨테이너와 서비스가 중단됩니다. 저장된 데이터는 유지됩니다.' : '저장된 컨테이너·이미지·볼륨은 다음 시작 시 다시 사용할 수 있습니다.'}</span>}
        </div>
      </>}
      {runtime.busy && query.error && <p role="status">작업 결과를 확인하지 못했습니다. 다시 조회하여 실제 완료 상태를 확인하세요.</p>}
    </div>
  </section>;
}
