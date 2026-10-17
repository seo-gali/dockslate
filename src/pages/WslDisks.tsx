import { useEffect, useMemo, useRef, useState } from 'react';
import { backend, refreshDashboardAfterMutation, type DiskOperation, type WslDisk, type WslInventory, type WslPreview, useBackendQuery } from '../api';
import { OperationNotice, type Operation } from '../actions';
import { ConfirmDialog, ErrorNotice, Icon, StatePanel, StatusBadge, errorMessage, formatBytes } from '../components';
import type { useDockSlateRuntime } from '../runtime';

const checkLabels: Record<string, string> = { ownership: 'WSL 등록 정보', runtimeOwner: '엔진 소유 정보', administrator: '관리자 권한', diskTools: 'Windows 디스크 관리 도구', wslStopped: 'WSL 배포판 종료', runtimeExited: '엔진·보조 프로세스 종료', detachedDynamicVhdx: 'VHDX 분리 상태', exclusiveLock: '디스크 파일 잠금', sourceIdentity: '원본 디스크 확인' };

function blockerText(reason: string): string {
  const running = 'Running WSL distributions must be stopped manually: ';
  const processes = 'Container runtime processes must be exited manually: ';
  if (reason.startsWith(running)) return `종료가 필요한 WSL 배포판: ${reason.slice(running.length)}`;
  if (reason.startsWith(processes)) return `종료가 필요한 런타임·보조 프로세스: ${reason.slice(processes.length)}`;
  if (reason.startsWith('An elevated Windows administrator session is required')) return '압축 검사·실행에는 관리자 권한으로 실행한 DockSlate가 필요합니다.';
  if (reason === 'Disk separation has not been verified by both Get-DiskImage and Get-VHD.') return '디스크 분리 상태를 아직 확인하지 못했습니다. 엔진 중지와 관리자 권한이 필요하며 Get-DiskImage·Get-VHD 검사가 모두 통과해야 합니다.';
  if (reason.startsWith('Disk separation cannot be verified:')) return '디스크 분리 상태 검사가 실패했습니다. 관리자 권한과 Get-DiskImage·Get-VHD 지원 여부를 확인하세요.';
  if (reason === 'WSL running state is unknown.') return 'WSL 실행 상태를 확인하지 못했습니다. 조회 진단을 확인하세요.';
  if (reason === 'Runtime process state is unknown.') return '런타임 프로세스 상태를 확인하지 못했습니다. 조회 진단을 확인하세요.';
  if (reason.startsWith('Required Windows disk tools are unavailable:')) return `Windows 디스크 관리 도구가 없습니다: ${reason.split(':').slice(1).join(':').trim()}`;
  if (reason === 'Disk inspection requires verified ownership and elevation.') return '소유 정보와 관리자 권한을 확인한 뒤 디스크 분리 상태를 검사할 수 있습니다.';
  if (reason.startsWith('Exclusive VHDX lock failed:')) return '디스크 파일을 다른 프로세스가 사용 중이거나 파일을 열 수 없습니다. 엔진과 파일 사용 프로그램을 종료한 뒤 다시 검사하세요.';
  if (reason.startsWith('Disk identity verification failed:')) return '앞의 검사를 모두 통과하면 원본 디스크를 확인할 수 있습니다.';
  return reason;
}

function Blockers({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return <><ul className="disk-blockers">{reasons.map((reason, index) => <li key={index} title={reason}><Icon name="warning" size={13} /><span>{blockerText(reason)}</span></li>)}</ul><details className="usage-note"><summary>원본 진단 보기</summary><ul>{reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details></>;
}

function previewChecks(value: unknown): { name: string; status: string; detail: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(check => typeof check === 'object' && check !== null && typeof check.name === 'string' && typeof check.status === 'string' && typeof check.detail === 'string' ? [{ name: check.name, status: check.status, detail: check.detail }] : []);
}

export default function WslDisks({ revision, onLoading, onCompacting, runtime, openRuntimeSettings }: { revision: number; onLoading: (loading: boolean) => void; onCompacting: (busy: boolean) => void; runtime?: ReturnType<typeof useDockSlateRuntime>; openRuntimeSettings?: () => void }) {
  const query = useBackendQuery<WslInventory>('wsl_inventory');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<WslPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation>(null);
  const [diskOperation, setDiskOperation] = useState<DiskOperation | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  const [restartApproved, setRestartApproved] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [openingFeatures, setOpeningFeatures] = useState(false);
  const compacting = submitting || uncertain || diskOperation?.status === 'in_progress';
  const previousDiskStatus = useRef<string | undefined>(undefined);
  const selected = query.data?.disks.find(disk => disk.id === selectedId) ?? null;
  const checks = useMemo(() => previewChecks(preview?.checks), [preview]);
  const canCompact = !!(preview?.eligible && preview.token && preview.diskId === selectedId);
  const previousRuntimeState = useRef(runtime?.query.data?.state);
  const runtimeState = runtime?.query.data?.state;
  const missingTools = checks.some(check => check.name === 'diskTools' && check.status !== 'passed');
  const checkBusy = query.loading || checking || compacting || !!runtime?.busy || restarting || openingFeatures;
  const requestRestart = () => { setRestartOpen(true); setRestartApproved(false); setRestartError(null); };
  const restartElevated = async () => {
    if (!restartApproved || checkBusy) return;
    setRestarting(true); setRestartError(null);
    try { await backend('desktop_restart_elevated', { approved: true }); }
    catch (failure) { setRestartError(errorMessage(failure)); }
    finally { setRestarting(false); }
  };
  const openFeatures = async () => {
    if (checkBusy) return;
    setOpeningFeatures(true);
    try { await backend('desktop_open_windows_features'); }
    catch (failure) { setOperation({ tone: 'danger', message: `Windows 기능 창을 열 수 없습니다: ${errorMessage(failure)}` }); }
    finally { setOpeningFeatures(false); }
  };
  useEffect(() => {
    if (previousRuntimeState.current !== runtimeState && previousRuntimeState.current !== undefined) {
      setPreview(null);
    }
    previousRuntimeState.current = runtimeState;
  }, [runtimeState]);
  const ownsDisk = (disk: WslDisk) => {
    const status = runtime?.query.data;
    const normalize = (path: string) => path.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '').toLowerCase();
    return disk.owner === 'DockSlate' && disk.distribution === 'DockSlate' && status?.distribution === disk.distribution &&
      (status.state === 'running' || status.state === 'stopped') && status.blockedReasons.length === 0 &&
      !!status.installPath && !!disk.path && disk.exists && normalize(disk.path) === normalize(`${status.installPath}\\ext4.vhdx`);
  };
  const preparation = (disk: WslDisk) => <div style={{ marginTop: 16 }}>
    <h3 style={{ fontSize: 13, marginBottom: 8 }}>압축 준비</h3>
    <ol className="usage-note" style={{ paddingLeft: 20, margin: 0 }}>
      <li><strong>엔진과 배포판 중지</strong><p>실행 중인 컨테이너와 서비스가 중단됩니다. 저장된 데이터는 유지됩니다.</p>
        {ownsDisk(disk) && runtime ? runtimeState === 'running' ? <button className="button small" disabled={runtime.controlsDisabled || checking || compacting} onClick={() => { setSelectedId(disk.id); setPreview(null); runtime.requestAction('stop'); }}><Icon name="stop" size={14} />DockSlate 엔진 중지…</button> : <p className="success">DockSlate 엔진 중지 상태를 확인했습니다.</p> : openRuntimeSettings && <button className="button small" disabled={query.loading || checking || compacting || runtime?.busy} onClick={openRuntimeSettings}>엔진 상태 확인</button>}
        {query.data?.runningDistributions.some(name => name !== disk.distribution) && <p>다른 실행 중 배포판도 종료되어야 합니다. 각 배포판의 작업을 저장하고 직접 종료하세요.</p>}
      </li>
      <li style={{ marginTop: 12 }}><strong>관리자 권한과 디스크 지원 확인</strong><p>{query.data?.admin ? '관리자 권한으로 실행 중입니다.' : '디스크 검사와 압축에는 관리자 권한이 필요합니다.'} Get-DiskImage·Get-VHD·Optimize-VHD 지원 여부도 함께 검사합니다.</p>{!query.data?.admin && <button className="button small" disabled={checkBusy} onClick={requestRestart}>관리자 권한으로 다시 실행</button>}</li>
    </ol>
    <p className="usage-note">백업 파일 없이 원본 VHDX를 압축합니다. 아래 검사는 파일을 변경하지 않으며, 모든 조건을 통과한 뒤 실행을 승인합니다.</p>
  </div>;
  const checkHelp = (name: string) => {
    switch (name) {
      case 'ownership': return '전체 새로고침으로 현재 WSL 등록 정보를 확인한 뒤 다시 검사하세요.';
      case 'runtimeOwner': return 'Settings에서 DockSlate 설치 경로와 엔진 상태를 확인하세요.';
      case 'administrator': return '아래 버튼으로 앱을 다시 열고 Windows 권한 요청을 승인하세요. 엔진 상태와 데이터는 유지됩니다.';
      case 'diskTools': return 'Windows 기능에서 Hyper-V 관리 도구의 Windows PowerShell용 Hyper-V 모듈을 확인하세요. 이 항목이 제공되지 않는 Windows에서는 현재 압축 방식을 사용할 수 없습니다. 기능을 변경했다면 Windows의 안내를 따르고 다시 검사하세요.';
      case 'wslStopped': return `종료할 배포판: ${query.data?.runningDistributions.join(', ') || '검사 진단 확인'}. 각 배포판의 작업을 저장한 뒤 종료하세요.`;
      case 'runtimeExited': return '검사 진단에 표시된 엔진과 보조 프로그램을 종료한 뒤 다시 검사하세요.';
      case 'detachedDynamicVhdx': return !query.data?.admin ? '관리자 권한으로 다시 실행하면 분리 상태를 검사할 수 있습니다.' : missingTools ? 'Windows 디스크 관리 도구를 준비한 뒤 다시 검사하세요.' : '엔진을 중지하고 디스크를 연결한 프로그램을 종료한 뒤 다시 검사하세요. 연결 상태를 확인하지 못하면 압축할 수 없습니다.';
      case 'exclusiveLock': return '엔진과 VHDX 파일을 사용하는 프로그램을 종료한 뒤 다시 검사하세요. 계속 잠겨 있으면 압축할 수 없습니다.';
      case 'sourceIdentity': return '앞의 조건을 모두 충족한 뒤 다시 검사하면 파일 식별 정보와 변경 여부를 확인합니다.';
      default: return '원본 진단을 확인한 뒤 다시 검사하세요.';
    }
  };
  const checkAction = (name: string) => {
    if (name === 'administrator' || (name === 'detachedDynamicVhdx' && !query.data?.admin)) return <button className="button small" disabled={checkBusy} onClick={requestRestart}>관리자 권한으로 다시 실행</button>;
    if (name === 'diskTools' || (name === 'detachedDynamicVhdx' && missingTools)) return <button className="button small" disabled={checkBusy} onClick={() => void openFeatures()}>{openingFeatures ? '여는 중…' : 'Windows 기능 열기'}</button>;
    if (name === 'runtimeOwner' && openRuntimeSettings) return <button className="button small" disabled={checkBusy} onClick={openRuntimeSettings}>설정에서 확인</button>;
    if (name === 'wslStopped' && selected && ownsDisk(selected) && runtimeState === 'running' && runtime) return <button className="button small" disabled={checkBusy || runtime.controlsDisabled} onClick={() => runtime.requestAction('stop')}>DockSlate 엔진 중지…</button>;
    return <button className="button small" disabled={checkBusy} onClick={() => void inspect()}>다시 검사</button>;
  };
  useEffect(() => { onLoading(query.loading || checking || submitting); }, [query.loading, checking, submitting, onLoading]);
  useEffect(() => { onCompacting(compacting); }, [compacting]);
  useEffect(() => {
    if (!query.data) return;
    const nextStatus = query.data.operation?.status;
    const previous = previousDiskStatus.current;
    previousDiskStatus.current = nextStatus;
    setDiskOperation(query.data.operation ?? null);
    setUncertain(false);
    if (previous === 'in_progress' && (nextStatus === 'completed' || nextStatus === 'failed')) void refreshDashboardAfterMutation();
  }, [query.data]);
  useEffect(() => {
    if (!compacting || query.loading) return;
    const timer = window.setTimeout(() => void query.poll(), 2000);
    return () => window.clearTimeout(timer);
  }, [compacting, query.loading, query.poll]);
  useEffect(() => {
    if (revision > 0) { if (!compacting) setPreview(null); void query.reload(); }
  }, [revision]);
  const select = (diskId: string) => {
    if (query.loading || checking || compacting || runtime?.busy) return;
    setSelectedId(previous => previous === diskId ? null : diskId);
    setPreview(null); setOperation(null);
  };
  const inspect = async () => {
    if (!selected || query.loading || checking || compacting || runtime?.busy) return;
    setChecking(true); setPreview(null); setOperation({ tone: 'accent', message: '소유 런타임, 종료·분리 상태와 실행 권한을 검사하고 있습니다…' });
    try {
      const result = await backend<WslPreview>('wsl_preview', { diskId: selected.id });
      setPreview(result);
      setOperation({ tone: result.eligible ? 'success' : 'danger', message: result.eligible ? '압축 사전 조건을 확인했습니다. 대상을 검토하고 승인하면 실행할 수 있습니다.' : '안전 조건을 충족하지 못해 압축이 차단되었습니다. 아래 검사 결과를 확인하세요.' });
    } catch (failure) { setOperation({ tone: 'danger', message: `사전 조건 검사 실패: ${errorMessage(failure)}` }); }
    finally { setChecking(false); }
  };
  const compact = async () => {
    if (!canCompact || !preview?.token || !acknowledged || submitting) return;
    setSubmitting(true); setDialogError(null); setOperation(null);
    try {
      const result = await backend<DiskOperation>('wsl_compact', { token: preview.token, approved: true });
      setDiskOperation(result);
      setDialogOpen(false); setAcknowledged(false); setPreview(null);
      await query.poll();
      if (result.status !== 'in_progress') await refreshDashboardAfterMutation();
    } catch (failure) {
      setDialogError(errorMessage(failure));
      setUncertain(true);
      await query.poll();
    } finally { setSubmitting(false); }
  };
  const copy = async (path: string) => {
    try { await navigator.clipboard.writeText(path); setOperation({ tone: 'success', message: 'VHDX 경로를 복사했습니다.' }); }
    catch (failure) { setOperation({ tone: 'danger', message: `경로 복사 실패: ${errorMessage(failure)}` }); }
  };

  return <>{restartOpen && <ConfirmDialog title="관리자 권한으로 다시 실행" label="다시 실행" busy={restarting} error={restartError} acknowledged={restartApproved} onAcknowledge={setRestartApproved} onCancel={() => { setRestartOpen(false); setRestartError(null); }} onConfirm={() => void restartElevated()}><p>현재 실행 중인 DockSlate를 관리자 권한으로 다시 엽니다. Windows 권한 요청이 표시됩니다.</p><p>새 창이 열리면 현재 창을 닫습니다. 검색과 선택한 항목은 초기화되며 엔진 상태와 저장된 데이터는 유지됩니다.</p><p>디스크 검사와 압축은 새 창에서 직접 실행합니다.</p></ConfirmDialog>}<OperationNotice operation={operation} onDismiss={() => setOperation(null)} />{compacting && <div className="notice warning-notice" role="status"><Icon name="refresh" /><div><strong>{uncertain ? '압축 작업 상태를 재확인하고 있습니다' : 'VHDX 압축 진행 중'}</strong><p>완료 결과를 확인할 때까지 앱을 닫거나 런타임 및 WSL 배포판을 시작하지 마세요. 상태를 2초 간격으로 다시 조회합니다.</p></div></div>}{diskOperation?.status === 'failed' && <div className="notice error" role="alert"><Icon name="warning" /><div><strong>압축 실패</strong><p>{diskOperation.error}</p>{diskOperation.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}{diskOperation?.status === 'completed' && <div className="compact-result" role="status"><strong>VHDX 압축 완료 · 실측 결과</strong><p className="mono" style={{ overflowWrap: 'anywhere' }}>{diskOperation.path}</p><dl><dt>작업 전 VHDX 파일 크기</dt><dd>{formatBytes(diskOperation.beforeBytes)}</dd><dt>작업 후 VHDX 파일 크기</dt><dd>{formatBytes(diskOperation.afterBytes)}</dd><dt>VHDX 파일 크기 감소량</dt><dd>{formatBytes(diskOperation.vhdxReductionBytes)}</dd><dt>Windows 파일 할당 공간 회수량</dt><dd>{formatBytes(diskOperation.reclaimedBytes)}</dd><dt>압축 방법</dt><dd>{diskOperation.method}</dd></dl>{diskOperation.warnings.map((warning, index) => <p className="muted" style={{ marginTop: 8 }} key={index}>{warning}</p>)}</div>}{query.error && <ErrorNotice message={query.error} onRetry={() => void query.reload()} />}{query.loading && !query.data ? <StatePanel busy icon="disk" title="WSL 디스크 조회 중" description="Windows WSL 등록 정보와 실제 VHDX 파일을 읽기 전용으로 확인합니다." /> : query.data && <>{query.data.diagnostics.length > 0 && <div className="notice warning-notice"><Icon name="warning" /><div><strong>WSL 조회 진단</strong>{query.data.diagnostics.map((diagnostic, index) => <p key={index}>{diagnostic}</p>)}</div></div>}<div className="section-heading"><div><h2>등록된 WSL 디스크</h2><p>관리자 권한: {query.data.admin ? '확인됨' : '없음'} · 실행 중 배포판: {query.data.runningDistributions.length > 0 ? query.data.runningDistributions.join(', ') : query.data.diagnostics.length ? '진단 내용 확인 필요' : '없음'}</p></div><span className="muted" style={{ fontSize: 11 }}>{query.data.disks.length}개</span></div>{query.data.runtimeProcesses && query.data.runtimeProcesses.length > 0 && <div className="notice warning-notice"><Icon name="warning" /><div><strong>실행 중인 런타임 프로세스</strong><p>{query.data.runtimeProcesses.join(', ')}</p><p>소유 런타임과 보조 프로세스가 종료되기 전에는 압축을 허용하지 않습니다.</p></div></div>}{query.data.disks.length === 0 ? <StatePanel icon="disk" title="확인된 WSL VHDX가 없습니다" description="현재 WSL 등록 정보에서 DockSlate 또는 지원하는 런타임 소유 디스크를 확인하지 못했습니다. 조회 진단이 있으면 함께 확인하세요." /> : <div className="disk-list">{query.data.disks.map(disk => <section className="disk-card" key={disk.id}><header className="disk-card-header"><div className="disk-title"><Icon name="disk" size={21} /><div><h2>{disk.owner}</h2><p>{disk.distribution}</p></div></div><StatusBadge tone={selectedId === disk.id && canCompact ? 'success' : 'warning'}>{selectedId === disk.id && canCompact ? '압축 조건 확인됨' : '압축 준비 필요'}</StatusBadge></header><div className="disk-card-body"><div className="disk-properties"><div><label>VHDX 파일 크기</label><strong>{disk.exists ? formatBytes(disk.fileSizeBytes) : '파일 없음'}</strong></div><div><label>WSL 배포판 상태</label><strong>{disk.running === null ? '미확인' : disk.running ? '실행 중' : '중지됨'}</strong></div><div><label>디스크 연결 상태</label><strong>{disk.attached === null ? '미확인' : disk.attached ? '연결됨' : '분리 확인됨'}</strong></div></div><div className="disk-path"><code>{disk.path ?? '미확인'}</code><button className="icon-button" disabled={!disk.path} onClick={() => void copy(disk.path ?? '')} title="VHDX 경로 복사" aria-label="VHDX 경로 복사"><Icon name="copy" size={15} /></button></div>{disk.blockedReasons.length > 0 && selectedId !== disk.id && <Blockers reasons={disk.blockedReasons} />}{selectedId === disk.id && <>{preparation(disk)}<div className="disk-inspection" style={{ marginTop: 16 }}><button className="button" type="button" disabled={query.loading || checking || compacting || runtime?.busy} onClick={() => void inspect()}>{checking ? '검사 중…' : '사전 조건 검사'}</button></div>{preview && <><ul className="prerequisite-list">{checks.map(check => <li key={check.name} className={check.status === 'passed' ? 'success' : 'warning'} data-check={check.name}><Icon name={check.status === 'passed' ? 'check' : 'warning'} size={14} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}><span>{checkLabels[check.name] ?? check.name}</span><StatusBadge tone={check.status === 'passed' ? 'muted' : 'warning'}>{check.status === 'passed' ? '확인됨' : '확인 필요'}</StatusBadge></div>{check.status !== 'passed' && <><p className="usage-note" style={{ margin: '6px 0' }}>{checkHelp(check.name)}</p>{check.name === 'diskTools' && <p className="usage-note selectable">{blockerText(check.detail)}</p>}{checkAction(check.name)}</>}<details className="usage-note"><summary>검사 진단</summary><p className="selectable">{check.detail}</p></details></div></li>)}</ul>{preview.blockedReasons.length > 0 && <details className="usage-note"><summary>전체 검사 진단</summary><ul className="selectable">{preview.blockedReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>}<details className="usage-note"><summary>압축 방법과 주의사항</summary>{preview.warnings.map((warning, index) => <p className="selectable" key={index}>{warning}</p>)}</details></>}</>}</div><footer className="disk-card-footer"><small>{selectedId === disk.id && canCompact ? '백업 없이 원본 디스크를 변경합니다.' : '안전 조건 검사 후에만 압축을 승인할 수 있습니다.'}</small><div className="disk-card-actions"><button className="button small" disabled={query.loading || checking || compacting || runtime?.busy} onClick={() => select(disk.id)}>{selectedId === disk.id ? '준비 패널 닫기' : '압축 준비 및 검사'}</button><button className="button small danger-button" disabled={selectedId !== disk.id || !canCompact || query.loading || checking || compacting || runtime?.busy} title={!canCompact ? '소유 런타임, 종료·분리 상태와 실행 권한 검증이 필요합니다' : '압축 대상과 영향을 확인합니다'} onClick={() => { setDialogOpen(true); setAcknowledged(false); setDialogError(null); }}>압축…</button></div></footer></section>)}</div>}<div className="notice info" style={{ marginTop: 18 }}><Icon name="check" /><div><strong>읽기 전용 탐색</strong><p>VHDX 파일 크기는 Docker 논리 사용량과 다릅니다. 압축은 확인된 대상에만 적용되며, 다른 WSL 배포판의 종료가 필요하면 해당 배포판의 영향을 확인하고 직접 종료하세요.</p></div></div></>}{dialogOpen && preview && <ConfirmDialog title="VHDX 압축 승인" label="검증된 VHDX 압축" busy={submitting} error={dialogError} acknowledged={acknowledged} onAcknowledge={setAcknowledged} onCancel={() => { setDialogOpen(false); setAcknowledged(false); setDialogError(null); }} onConfirm={() => void compact()}><div className="dialog-target">{preview.path}<small>소유 런타임: {selected?.owner ?? '미확인'} · 배포판: {selected?.distribution ?? '미확인'}</small></div><p>현재 VHDX 파일 크기: <strong>{formatBytes(preview.fileSizeBytes)}</strong></p><p>백업을 만들지 않고 원본 VHDX를 직접 변경합니다. DockSlate에서 되돌릴 수 없고 실패 시 데이터 복구를 보장하지 않습니다. 파일 크기 감소는 보장되지 않습니다.</p>{preview.warnings.map((warning, index) => <p key={index}>{warning}</p>)}<p>승인 정보 만료: {preview.expiresAt ? new Date(preview.expiresAt).toLocaleTimeString() : '미확인'}</p></ConfirmDialog>}</>;
}
