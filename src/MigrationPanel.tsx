import { useEffect, useRef, useState } from 'react';
import { backend, refreshDashboardAfterMutation } from './api';
import { ConfirmDialog, ErrorNotice, errorMessage } from './components';
import { t } from './i18n';
import type { Inventory, Job, Preview, Selection } from './ipc/contracts/migration';

export default function MigrationPanel({ active, connected, blocked, onBusy }: { active: boolean; connected: boolean; blocked: boolean; onBusy: (value: boolean) => void }) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [selection, setSelection] = useState<Selection>({ images: [], containers: [], volumes: [] });
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
    try { setInventory(await backend('migration_inventory')); setSelection({ images: [], containers: [], volumes: [] }); }
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
  return <section className="settings-panel" hidden={!active}>
    <h2>{t('Docker Desktop에서 가져오기')}</h2>
    <div className="settings-help migration-content">
    <div>
      <p>{t('이미지·중지된 컨테이너·볼륨을 DockSlate로 복사합니다. Docker Desktop은 실행한 채로 두세요. 원본 데이터는 삭제하지 않습니다.')}</p>
      <p className="usage-note">{t('컨테이너와 볼륨을 쓰는 서비스를 먼저 정상 중지하세요. 복사본의 동작을 확인하기 전에는 Docker Desktop을 제거하지 마세요.')}</p>
    </div>
    {!connected && <p className="usage-note warning">{t('DockSlate 엔진을 먼저 시작하세요.')}</p>}
    <button className="button" disabled={busy || blocked || !connected} onClick={() => void load()}>{working ? t('검사 중…') : t('Docker Desktop 목록 조회')}</button>
    {error && <ErrorNotice message={error} />}
    {inventory && <>
      <dl className="settings-properties"><dt>Docker Desktop</dt><dd className="mono">{inventory.sourceEngine}</dd><dt>DockSlate</dt><dd className="mono">{inventory.targetEngine}</dd></dl>
      {(['containers', 'volumes', 'images'] as const).map(kind => <fieldset key={kind} disabled={busy || blocked}><legend>{t({ containers: '컨테이너', volumes: '볼륨', images: '이미지' }[kind])}</legend>
        {inventory[kind].length === 0 && <p className="muted">{t('없음')}</p>}
        {inventory[kind].map((item, index) => <label key={`${item.id}:${index}`} className="checkbox-control" style={{ display: 'flex', marginBottom: 8 }}><input type="checkbox" checked={selection[kind].includes(item.id)} onChange={event => { setSelection(current => ({ ...current, [kind]: event.target.checked ? [...current[kind], item.id] : current[kind].filter(id => id !== item.id) })); setPreview(null); setApproved(false); }} /><span className="mono">{item.name}</span><small className="muted">{item.detail}</small></label>)}
      </fieldset>)}
      <p className="usage-note">{t('컨테이너에 필요한 이미지·볼륨·bridge 네트워크도 함께 검사합니다. 환경 변수에 저장한 비밀번호는 복사되며 값은 여기에 표시하지 않습니다.')}</p>
      <button className="button primary" disabled={busy || blocked || !Object.values(selection).some(items => items.length > 0)} onClick={() => void inspect()}>{t('가져올 대상 검사')}</button>
    </>}
    {preview && !preview.eligible && <div className="notice error" role="alert"><div><strong>{t('가져올 수 없는 항목')}</strong><ul>{preview.blockedReasons.map((reason, index) => <li key={index}>{t(reason)}</li>)}</ul></div></div>}
    {job && <div aria-live="polite" role="status"><h3>{t(job.state === 'running' ? '데이터 복사 중' : job.state === 'completed' ? '데이터 복사 완료' : '데이터 복사 중단')}</h3><p>{t(job.message)}</p>{job.state === 'running' && <progress aria-label={t('데이터 복사 중')} />}{job.error && <ErrorNotice message={job.error} />}<ul>{job.completed.map((item, index) => <li key={index}>{item}</li>)}</ul>{job.warnings.map((item, index) => <p className="usage-note warning" key={index}>{item}</p>)}</div>}
    </div>
    {preview?.eligible && <ConfirmDialog title={t('Docker Desktop 데이터 복사 승인')} label={t('복사 시작')} busy={working} error={null} acknowledged={approved} onAcknowledge={setApproved} onCancel={() => { setPreview(null); setApproved(false); }} onConfirm={() => void execute()}>
      <p>Docker Desktop → DockSlate</p>
      {(['containers', 'volumes', 'images', 'networks'] as const).map(kind => <div key={kind}><strong>{t({ containers: '컨테이너', volumes: '볼륨', images: '이미지', networks: '네트워크' }[kind])} · {preview[kind].length}</strong><ul className="dialog-target-list">{preview[kind].map(value => <li key={value}>{value}</li>)}</ul></div>)}
      <p>{t('원본 데이터는 보존합니다. 볼륨 복사를 위해 양쪽 엔진에 실행하지 않는 임시 컨테이너를 만들고 정리합니다. 새 이미지를 다운로드하지 않습니다.')}</p>
      <p>{t('기존 환경 변수·포트·재시작 정책을 복사합니다. 새 컨테이너는 중지 상태이며 다음 엔진 시작 때 재시작 정책이 적용될 수 있습니다. 쓰기 계층은 보존하지만 원래 이미지 레이어 이력·로그·tmpfs·메모리는 이전하지 않습니다.')}</p>
      <p>{t('이전 중에는 양쪽 엔진의 데이터를 변경하지 마세요. 임시 tar는 파일당 64 GiB·복사당 1시간까지 지원합니다. 실패해도 이미 복사한 대상은 남겨 둡니다.')}</p>
    </ConfirmDialog>}
  </section>;
}
