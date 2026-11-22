import { useEffect, useRef, useState } from 'react';
import { backend, refreshDashboardAfterMutation } from './api';
import { ConfirmDialog, ErrorNotice, errorMessage } from './components';
import { t } from './i18n';
import type { Inventory, Job, Preview, Selection } from './ipc/contracts/migration';

const kinds = ['containers', 'volumes', 'images'] as const;
const emptySelection = (): Selection => ({ images: [], containers: [], volumes: [], stopRunning: true, startAfterImport: true });

export default function MigrationPanel({ active, connected, blocked, onBusy }: { active: boolean; connected: boolean; blocked: boolean; onBusy: (value: boolean) => void }) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const request = useRef(false);
  const busy = working || job?.state === 'running';
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => { let live = true; if (active) void backend('migration_status').then(value => { if (live) setJob(value); }).catch(failure => { if (live) setError(errorMessage(failure)); }); return () => { live = false; }; }, [active]);
  useEffect(() => {
    if (job?.state !== 'running') return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const value = await backend('migration_status');
        if (disposed) return;
        if (!value) throw new Error(t('가져오기 상태를 확인할 수 없습니다.'));
        setJob(value);
        if (value.state !== 'running') { await refreshDashboardAfterMutation(); return; }
      } catch (failure) { if (!disposed) setError(errorMessage(failure)); }
      if (!disposed) timer = window.setTimeout(() => void poll(), 800);
    };
    timer = window.setTimeout(() => void poll(), 300);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [job?.id, job?.state]);
  const load = async () => {
    if (request.current || busy || blocked) return;
    request.current = true; setWorking(true); setError(null); setPreview(null);
    try { setInventory(await backend('migration_inventory')); setSelection(current => ({ ...emptySelection(), stopRunning: current.stopRunning, startAfterImport: current.startAfterImport })); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { request.current = false; setWorking(false); }
  };
  const inspect = async () => {
    if (request.current || busy || blocked) return;
    request.current = true; setWorking(true); setError(null); setApproved(false);
    try { setPreview(await backend('migration_preview', { selection })); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { request.current = false; setWorking(false); }
  };
  const execute = async () => {
    if (!preview?.eligible || !approved || request.current || busy || blocked) return;
    if (preview.expiresAt <= Date.now()) { setPreview(null); setApproved(false); setError(t('승인 정보가 만료되었습니다. 다시 검사하세요.')); return; }
    request.current = true; setWorking(true); setError(null);
    try { setJob(await backend('migration_execute', { token: preview.token, approved: true })); setPreview(null); }
    catch (failure) { setPreview(null); setError(errorMessage(failure)); }
    finally { request.current = false; setWorking(false); setApproved(false); }
  };
  const change = (next: Selection) => { setSelection(next); setPreview(null); setApproved(false); };
  const count = kinds.reduce((sum, kind) => sum + selection[kind].length, 0);
  const allSelected = !!inventory && kinds.every(kind => inventory[kind].every(item => selection[kind].includes(item.id)));
  return <section className="settings-panel" hidden={!active}>
    <h2>{t('Docker Desktop에서 가져오기')}</h2>
    <div className="settings-help migration-content">
    <div>
      <p>{t('컨테이너 설정·이미지·볼륨과 연결된 파일·폴더를 DockSlate로 옮깁니다. Docker Desktop은 실행한 채로 두세요. 원본 데이터는 삭제하지 않습니다.')}</p>
      <p className="usage-note">{t('승인 후 선택한 원본을 정상 중지하고 복사합니다. 복사본의 동작을 확인하기 전에는 Docker Desktop을 제거하지 마세요.')}</p>
    </div>
    {!connected && <p className="usage-note warning">{t('DockSlate 엔진을 먼저 시작하세요.')}</p>}
    <button className="button" disabled={busy || blocked || !connected} onClick={() => void load()}>{working ? t('검사 중…') : t('Docker Desktop 목록 조회')}</button>
    {error && <ErrorNotice message={error} />}
    {inventory && <>
      <dl className="settings-properties"><dt>Docker Desktop</dt><dd className="mono">{inventory.sourceEngine}</dd><dt>DockSlate</dt><dd className="mono">{inventory.targetEngine}</dd></dl>
      <div className="migration-selection-actions"><button className="button small" disabled={busy || blocked || kinds.every(kind => inventory[kind].length === 0)} onClick={() => change({ ...selection, ...Object.fromEntries(kinds.map(kind => [kind, allSelected ? [] : [...new Set(inventory[kind].map(item => item.id))]])) })}>{t(allSelected ? '선택 해제' : '전체 선택')}</button><span className="usage-note">{t('{count}개 선택됨', { count })}</span></div>
      <fieldset className="migration-options" disabled={busy || blocked}><legend>{t('설정·데이터 그대로 이전')}</legend>
        <label className="checkbox-control"><input type="checkbox" checked={selection.stopRunning} onChange={event => change({ ...selection, stopRunning: event.target.checked })} />{t('실행 중인 원본 정상 중지')}</label>
        <label className="checkbox-control"><input type="checkbox" checked={selection.startAfterImport} onChange={event => change({ ...selection, startAfterImport: event.target.checked })} />{t('원래 실행 상태 유지')}</label>
        <p className="usage-note">{t('복사가 모두 끝난 뒤 원래 실행 중이던 컨테이너만 DockSlate에서 시작합니다. 원본은 중지 상태로 보존합니다.')}</p>
      </fieldset>
      {kinds.map(kind => <fieldset key={kind} disabled={busy || blocked}><legend>{t({ containers: '컨테이너', volumes: '볼륨', images: '이미지' }[kind])}</legend>
        {inventory[kind].length > 0 && <label className="checkbox-control migration-select-all"><input type="checkbox" checked={inventory[kind].every(item => selection[kind].includes(item.id))} ref={input => { if (input) input.indeterminate = selection[kind].length > 0 && !inventory[kind].every(item => selection[kind].includes(item.id)); }} onChange={event => change({ ...selection, [kind]: event.target.checked ? [...new Set(inventory[kind].map(item => item.id))] : [] })} />{t('전체 선택')}</label>}
        {inventory[kind].length === 0 && <p className="muted">{t('없음')}</p>}
        {inventory[kind].map((item, index) => <label key={`${item.id}:${index}`} className="checkbox-control migration-item"><input type="checkbox" checked={selection[kind].includes(item.id)} onChange={event => change({ ...selection, [kind]: event.target.checked ? [...new Set([...selection[kind], item.id])] : selection[kind].filter(id => id !== item.id) })} /><span className="mono">{item.name}</span><small className="muted">{item.detail}</small></label>)}
      </fieldset>)}
      <p className="usage-note">{t('컨테이너에 필요한 이미지·볼륨·bridge 네트워크도 함께 검사합니다. 환경 변수에 저장한 비밀번호는 복사되며 값은 여기에 표시하지 않습니다.')}</p>
      <p className="usage-note">{t('연결된 파일·폴더는 별도 볼륨으로 복사하며 컨테이너 안 경로를 유지합니다. 원래 호스트 폴더와는 이후 동기화되지 않습니다.')}</p>
      <button className="button primary" disabled={busy || blocked || count === 0} onClick={() => void inspect()}>{t('가져올 대상 검사')}</button>
    </>}
    {preview && !preview.eligible && <div className="notice error" role="alert"><div><strong>{t('가져올 수 없는 항목')}</strong><ul>{preview.blockedReasons.map((reason, index) => <li key={index}>{t(reason)}</li>)}</ul></div></div>}
    {job && <div aria-live="polite" role="status"><h3>{t(job.state === 'running' ? '데이터 복사 중' : job.state === 'completed' ? '데이터 복사 완료' : '데이터 복사 중단')}</h3><p>{t(job.message)}</p>{job.state === 'running' && <progress aria-label={t('데이터 복사 중')} />}{job.error && <ErrorNotice message={job.error} />}{!!job.stoppedSources?.length && <p>{t('중지한 원본')}: {job.stoppedSources.join(', ')}</p>}{!!job.startedTargets?.length && <p>{t('시작한 복사본')}: {job.startedTargets.join(', ')}</p>}<ul>{job.completed.map((item, index) => <li key={index}>{item}</li>)}</ul>{job.warnings.map((item, index) => <p className="usage-note warning" key={index}>{item}</p>)}</div>}
    </div>
    {preview?.eligible && <ConfirmDialog title={t('Docker Desktop 데이터 복사 승인')} label={t('복사 시작')} busy={working} error={null} acknowledged={approved} onAcknowledge={setApproved} onCancel={() => { setPreview(null); setApproved(false); }} onConfirm={() => void execute()}>
      <p>Docker Desktop → DockSlate</p>
      {(['containers', 'volumes', 'images', 'networks'] as const).map(kind => <div key={kind}><strong>{t({ containers: '컨테이너', volumes: '볼륨', images: '이미지', networks: '네트워크' }[kind])} · {preview[kind].length}</strong><ul className="dialog-target-list">{preview[kind].map(value => <li key={value}>{value}</li>)}</ul></div>)}
      {!!preview.stopContainers.length && <div><strong>{t('정상 중지할 원본')}</strong><ul className="dialog-target-list">{preview.stopContainers.map(value => <li key={value}>{value}</li>)}</ul><p>{t('정상 종료를 최대 3분 기다립니다. 강제 종료하지 않습니다. 실패하면 중지한 원본 목록을 확인하세요.')}</p></div>}
      {!!preview.startContainers.length && <div><strong>{t('복사 후 시작할 컨테이너')}</strong><ul className="dialog-target-list">{preview.startContainers.map(value => <li key={value}>{value}</li>)}</ul></div>}
      {!!preview.binds.length && <div><strong>{t('함께 복사할 파일·폴더')}</strong><ul className="dialog-target-list">{preview.binds.map(value => <li key={value.volume}><span className="mono">{value.source}</span> → <span className="mono">{value.volume}</span></li>)}</ul><p>{t('원래 호스트 폴더와는 이후 동기화되지 않습니다. 폴더를 변경하는 외부 프로그램도 중지하세요.')}</p></div>}
      {!!preview.dockerSocketContainers.length && <div className="notice warning-notice"><p>{t('Docker 소켓을 DockSlate 엔진으로 연결합니다. 이 컨테이너는 새 엔진을 관리할 권한을 가집니다.')}: {preview.dockerSocketContainers.join(', ')}</p></div>}
      {!!preview.reusedNetworks.length && <p>{t('기존에 이전한 동일 설정의 네트워크를 재사용합니다.')}: {preview.reusedNetworks.join(', ')}</p>}
      <p>{t('원본 데이터는 보존합니다. 볼륨 복사를 위해 양쪽 엔진에 실행하지 않는 임시 컨테이너를 만들고 정리합니다. 새 이미지를 다운로드하지 않습니다.')}</p>
      <p>{t('기존 환경 변수·포트·재시작 정책과 쓰기 계층을 복사합니다. 원래 이미지 레이어 이력·로그·tmpfs·메모리는 이전하지 않습니다. 원본과 복사본을 동시에 실행하지 마세요.')}</p>
      <p>{t('이전 중에는 양쪽 엔진의 데이터를 변경하지 마세요. 임시 tar는 파일당 64 GiB·복사당 1시간까지 지원합니다. 실패해도 이미 복사한 대상은 남겨 둡니다.')}</p>
    </ConfirmDialog>}
  </section>;
}
