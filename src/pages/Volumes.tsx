import { useEffect, useMemo, useRef, useState } from 'react';
import { EngineGate, type EngineProps } from '../App';
import { backend, refreshDashboardAfterMutation, useBackendQuery } from '../api';
import { OperationNotice, type Operation } from '../actions';
import { ConfirmDialog, DetailPanel, ErrorNotice, Icon, PageHeader, Pagination, RefreshButton, SearchInput, StatePanel, StatusBadge, errorMessage, formatBytes } from '../components';

interface VolumeReference { id: string; name: string; state: string }
export interface DockerVolume {
  name: string; driver: string; scope: string; mountpoint: string; createdAt: string | null;
  labels: Record<string, string> | null; options: Record<string, string> | null;
  referenceCount: number; activeReferences: number; containers: VolumeReference[];
  sizeBytes: number | null; fileSupported: boolean;
}
interface VolumeJob { id: string; kind: string; name: string; destination?: string; state: 'running' | 'completed' | 'failed'; entries: number; bytes: number; error?: string; result?: { message?: string; path?: string; bytes?: number; entries?: number } }
interface ArchiveSelection { cancelled: boolean; token?: string; path?: string; sizeBytes?: number }
interface VolumePreview {
  name: string; kind: 'delete' | 'empty' | 'import'; eligible: boolean; token: string | null; expiresAt: number | null;
  mode: 'merge' | 'replace' | null;
  importPlan: { overwrittenFiles: number; overwrittenPaths: string[]; overwrittenPathsTruncated: boolean; createdFiles: number; removedEntries: number; removedBytes: number; preservedEntries: number } | null;
  references: VolumeReference[]; blockedReasons: string[]; summary: { entries: number; bytes: number } | null;
  archive: { path: string; entries: number; bytes: number } | null; impact: string; warnings: string[];
}
interface DirectoryEntry { name: string; kind: 'directory' | 'file' | 'unsupported'; size: number; modified: number }
interface Directory { path: string; entries: DirectoryEntry[] }
interface FilePreview { path: string; text: string; truncated: boolean; limitBytes: number }
const labels = { delete: '볼륨 삭제', empty: '볼륨 비우기', import: 'tar 가져오기' };

function VolumeFiles({ volume, blocked }: { volume: DockerVolume; blocked: boolean }) {
  const [path, setPath] = useState('');
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [file, setFile] = useState<FilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const generation = useRef(0);
  const browse = async (next: string) => {
    const current = ++generation.current;
    setLoading(true); setFailure(null); setFile(null);
    try { const result = await backend<Directory>('volume_browse', { name: volume.name, path: next }); if (current === generation.current) { setDirectory(result); setPath(next); } }
    catch (error) { if (current === generation.current) setFailure(errorMessage(error)); }
    finally { if (current === generation.current) setLoading(false); }
  };
  useEffect(() => { void browse(''); return () => { generation.current += 1; }; }, [volume.name]);
  const preview = async (entry: DirectoryEntry) => {
    const current = ++generation.current;
    setLoading(true); setFailure(null);
    const relative = [path, entry.name].filter(Boolean).join('/');
    try { const result = await backend<FilePreview>('volume_file_preview', { name: volume.name, path: relative }); if (current === generation.current) setFile(result); }
    catch (error) { if (current === generation.current) setFailure(errorMessage(error)); }
    finally { if (current === generation.current) setLoading(false); }
  };
  return <div className="detail-content">
    <div className="toolbar"><button className="button small" disabled={!path || loading || blocked} onClick={() => void browse(path.split('/').slice(0, -1).join('/'))}>상위 폴더</button><button className="button small" disabled={loading || blocked} onClick={() => void browse(path)}><Icon name="refresh" size={14} />폴더 새로고침</button></div>
    <p className="mono selectable" style={{ overflowWrap: 'anywhere', marginBottom: 12 }}>/{path}</p>
    {failure && <ErrorNotice message={failure} />}
    {loading && <p className="loading-line" role="status">파일 정보를 읽고 있습니다.</p>}
    {directory && <div className="table-wrap"><table className="data-table" style={{ minWidth: 0 }} aria-label="볼륨 파일"><thead><tr><th>이름</th><th style={{ width: 80 }}>크기</th></tr></thead><tbody>{directory.entries.map(entry => <tr key={entry.name}><td><button className="inline-link" style={{ overflowWrap: 'anywhere' }} disabled={loading || blocked || entry.kind === 'unsupported'} onClick={() => entry.kind === 'directory' ? void browse([path, entry.name].filter(Boolean).join('/')) : void preview(entry)} title={entry.kind === 'unsupported' ? '링크와 장치는 열 수 없습니다' : entry.kind === 'directory' ? '폴더 열기' : '텍스트 미리보기'}>{entry.kind === 'directory' ? '▸ ' : ''}{entry.name}</button>{entry.kind === 'unsupported' && <span className="cell-subtext">미지원 파일 형식</span>}</td><td>{entry.kind === 'file' ? formatBytes(entry.size) : ''}</td></tr>)}</tbody></table>{directory.entries.length === 0 && <p className="usage-note" style={{ padding: 12 }}>빈 폴더입니다.</p>}</div>}
    {file && <section aria-label="볼륨 파일 미리보기" style={{ marginTop: 14 }}><div className="section-heading"><strong className="mono" style={{ overflowWrap: 'anywhere' }}>{file.path}</strong><button className="icon-button" onClick={() => setFile(null)} title="미리보기 닫기" aria-label="미리보기 닫기"><Icon name="close" /></button></div><pre className="logs" tabIndex={0} style={{ maxHeight: 360, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{file.text || '(빈 파일)'}</pre>{file.truncated && <p className="usage-note">64 KB를 넘는 뒷부분은 표시하지 않습니다.</p>}</section>}
  </div>;
}

export default function Volumes(props: EngineProps & { onBusy?: (busy: boolean) => void }) {
  const query = useBackendQuery<DockerVolume[]>('volumes_list', undefined, props.engine?.state === 'connected');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [tab, setTab] = useState<'details' | 'files'>('details');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [working, setWorking] = useState(false);
  const [operation, setOperation] = useState<Operation>(null);
  const [job, setJob] = useState<VolumeJob | null>(null);
  const [target, setTarget] = useState<{ kind: VolumePreview['kind']; volume: DockerVolume; mode: 'merge' | 'replace' } | null>(null);
  const [preview, setPreview] = useState<VolumePreview | null>(null);
  const [validating, setValidating] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const dialogGeneration = useRef(0);
  const inFlight = useRef(false);
  const running = job?.state === 'running';
  const busy = working || running || !!props.mutationBlocked;
  useEffect(() => { props.onBusy?.(working || running || executing); return () => props.onBusy?.(false); }, [working, running, executing, props.onBusy]);
  useEffect(() => {
    if (!job || job.state !== 'running') return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const result = await backend<VolumeJob>('volume_job_status', { id: job.id });
        if (disposed) return;
        setJob(result);
        if (result.state !== 'running') {
          setOperation({ tone: result.state === 'completed' ? 'success' : 'danger', message: result.error ?? result.result?.message ?? '볼륨 작업을 마쳤습니다.' });
          await refreshDashboardAfterMutation();
          return;
        }
      } catch (error) { if (!disposed) setOperation({ tone: 'warning', message: `볼륨 작업 상태를 확인하지 못했습니다. 다시 확인합니다. ${errorMessage(error)}` }); }
      if (!disposed) timer = window.setTimeout(() => void poll(), 800);
    };
    timer = window.setTimeout(() => void poll(), 300);
    return () => { disposed = true; if (timer) window.clearTimeout(timer); };
  }, [job?.id, job?.state]);
  const selected = query.data?.find(volume => volume.name === selectedName) ?? null;
  const filtered = useMemo(() => (query.data ?? []).filter(volume => `${volume.name} ${volume.driver} ${volume.containers.map(container => container.name).join(' ')}`.toLowerCase().includes(search.toLowerCase())), [query.data, search]);
  useEffect(() => { setPage(0); }, [search]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 50) - 1));
  const mutate = async (action: () => Promise<void>) => {
    if (inFlight.current || busy) return;
    inFlight.current = true; setWorking(true); setOperation(null);
    try { await action(); }
    catch (error) { setOperation({ tone: 'danger', message: errorMessage(error) }); }
    finally { inFlight.current = false; setWorking(false); }
  };
  const create = () => mutate(async () => {
    const result = await backend<{ message: string; name: string }>('volume_create', { name: newName.trim() });
    setOperation({ tone: 'success', message: result.message }); setNewName(''); setShowCreate(false); setSelectedName(result.name); setTab('details');
    await refreshDashboardAfterMutation();
  });
  const clone = (volume: DockerVolume) => mutate(async () => {
    setJob(await backend<VolumeJob>('volume_clone', { name: volume.name, destination: cloneName.trim() }));
    setCloneName('');
  });
  const exportArchive = (volume: DockerVolume) => mutate(async () => {
    const archive = await backend<ArchiveSelection>('volume_pick_archive', { purpose: 'export' });
    if (archive.cancelled || !archive.token) return;
    setJob(await backend<VolumeJob>('volume_export', { name: volume.name, archiveToken: archive.token }));
  });
  const prepare = async (kind: VolumePreview['kind'], volume: DockerVolume, archiveToken?: string) => {
    if (busy || target) return;
    const current = ++dialogGeneration.current;
    setTarget({ kind, volume, mode: importMode }); setPreview(null); setAcknowledged(false); setDialogError(null); setValidating(true);
    try {
      const result = await backend<VolumePreview>(kind === 'import' ? 'volume_import_preview' : 'volume_destructive_preview', kind === 'import' ? { name: volume.name, archiveToken, mode: importMode } : { kind, name: volume.name });
      if (current === dialogGeneration.current) setPreview(result);
      else if (result.token) void backend('volume_discard_preview', { token: result.token }).catch(() => {});
    } catch (error) { if (current === dialogGeneration.current) setDialogError(errorMessage(error)); }
    finally { if (current === dialogGeneration.current) setValidating(false); }
  };
  const importArchive = async (volume: DockerVolume) => {
    if (inFlight.current || busy) return;
    inFlight.current = true; setWorking(true);
    try { const archive = await backend<ArchiveSelection>('volume_pick_archive', { purpose: 'import' }); if (!archive.cancelled && archive.token) { setWorking(false); await prepare('import', volume, archive.token); } }
    catch (error) { setOperation({ tone: 'danger', message: errorMessage(error) }); }
    finally { inFlight.current = false; setWorking(false); }
  };
  const cancel = () => { if (executing) return; if (preview?.token) void backend('volume_discard_preview', { token: preview.token }).catch(() => {}); dialogGeneration.current += 1; setTarget(null); setPreview(null); setValidating(false); setDialogError(null); setAcknowledged(false); };
  const execute = async () => {
    if (!preview?.token || !preview.eligible || !acknowledged || executing) return;
    if (!preview.expiresAt || preview.expiresAt <= Date.now()) { setDialogError('승인 정보가 만료되었습니다. 취소 후 다시 검사하세요.'); return; }
    setExecuting(true); setDialogError(null);
    try {
      const result = await backend<VolumeJob & { message?: string }>('volume_execute', { token: preview.token, approved: true });
      if (result.state === 'running') setJob(result);
      else { setOperation({ tone: 'success', message: result.message ?? '볼륨을 변경했습니다.' }); await refreshDashboardAfterMutation(); }
      dialogGeneration.current += 1; setTarget(null); setPreview(null); setAcknowledged(false);
    } catch (error) { setDialogError(errorMessage(error)); setPreview(null); }
    finally { setExecuting(false); }
  };
  return <>
    <PageHeader title="Volumes"><RefreshButton busy={query.loading || props.engineLoading || busy} onClick={() => void props.reloadEngine()} /><button className="button primary" disabled={busy || props.engine?.state !== 'connected'} aria-expanded={showCreate} onClick={() => setShowCreate(value => !value)}>볼륨 만들기</button></PageHeader>
    <OperationNotice operation={operation} onDismiss={() => setOperation(null)} />
    {job && <div className={`operation-banner ${job.state === 'running' ? 'accent' : job.state === 'failed' ? 'danger' : 'success'}`} role="status"><Icon name={job.state === 'running' ? 'refresh' : job.state === 'failed' ? 'warning' : 'check'} /><span>{job.name}{job.destination ? ` → ${job.destination}` : ''} · {{ clone: '복제', export: '내보내기', import: '가져오기', empty: '비우기' }[job.kind] ?? job.kind} {job.state === 'running' ? '진행 중' : job.state === 'completed' ? '완료' : '실패'} · {job.entries.toLocaleString()}개 처리 · {formatBytes(job.bytes)}{job.result?.path && <span className="cell-subtext selectable">{job.result.path}</span>}</span>{job.state !== 'running' && <button className="icon-button" onClick={() => setJob(null)} title="작업 결과 닫기" aria-label="작업 결과 닫기"><Icon name="close" /></button>}</div>}
    <EngineGate {...props}>
      {showCreate && <section className="panel" style={{ marginBottom: 16 }} aria-label="볼륨 만들기"><form className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }} onSubmit={event => { event.preventDefault(); void create(); }}><div className="field"><label htmlFor="volume-name">새 볼륨 이름</label><input id="volume-name" className="text-input" value={newName} onChange={event => setNewName(event.target.value)} maxLength={128} placeholder="예: project-data" disabled={busy} spellCheck={false} /></div><button className="button primary" disabled={!newName.trim() || busy}>만들기</button><button type="button" className="button" disabled={busy} onClick={() => setShowCreate(false)}>닫기</button></form></section>}
      <div className="toolbar"><SearchInput value={search} onChange={setSearch} placeholder="볼륨 이름, 드라이버, 컨테이너 검색…" /></div>
      {query.error && <ErrorNotice message={query.error} onRetry={() => void query.reload()} />}
      {query.loading && !query.data ? <StatePanel busy title="볼륨 조회 중" /> : query.data?.length === 0 ? <StatePanel icon="disk" title="볼륨이 없습니다" description="볼륨 만들기로 영구 저장 공간을 추가하세요." /> : query.data && <div className={`split-view ${selected ? 'with-detail' : ''}`}><div><div className="table-wrap"><table className="data-table" aria-label="볼륨 목록"><thead><tr><th>이름</th><th>드라이버</th><th>컨테이너 참조</th><th>크기</th><th style={{ width: 76 }}>작업</th></tr></thead><tbody>{filtered.slice(currentPage * 50, (currentPage + 1) * 50).map(volume => <tr key={volume.name} className={volume.name === selectedName ? 'selected' : ''}><td><button className="inline-link" onClick={() => { setSelectedName(volume.name); setTab('details'); setCloneName(''); }}>{volume.name}</button></td><td>{volume.driver}</td><td><StatusBadge tone={volume.activeReferences ? 'success' : volume.referenceCount ? 'accent' : 'muted'}>{volume.referenceCount ? `${volume.referenceCount}개${volume.activeReferences ? ' · 사용 중' : ' · 중지됨'}` : '미사용'}</StatusBadge></td><td>{formatBytes(volume.sizeBytes)}</td><td><button className="icon-button" disabled={busy} onClick={() => void prepare('delete', volume)} title="볼륨 삭제 확인" aria-label={`${volume.name} 볼륨 삭제 확인`}><Icon name="trash" size={16} /></button></td></tr>)}</tbody></table><Pagination page={currentPage} count={filtered.length} onPage={setPage} /></div>{filtered.length === 0 && <StatePanel icon="search" title="검색 결과가 없습니다" />}</div>
        {selected && <DetailPanel title={selected.name} onClose={() => { setSelectedName(null); setTab('details'); }}><div className="detail-tabs"><div className="segmented"><button className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>정보</button><button className={tab === 'files' ? 'active' : ''} disabled={!selected.fileSupported} title={!selected.fileSupported ? '드라이버 옵션이 없는 local 볼륨에서 지원합니다' : '볼륨 파일 보기'} onClick={() => setTab('files')}>파일</button></div></div>{tab === 'files' ? <VolumeFiles key={selected.name} volume={selected} blocked={busy} /> : <div className="detail-content"><dl className="detail-meta"><dt>드라이버</dt><dd>{selected.driver} · {selected.scope}</dd><dt>생성 시각</dt><dd>{selected.createdAt ? new Date(selected.createdAt).toLocaleString() : '미확인'}</dd><dt>엔진 내부 경로</dt><dd className="mono selectable" style={{ overflowWrap: 'anywhere' }}>{selected.mountpoint}</dd></dl><h3 style={{ margin: '18px 0 10px' }}>참조 컨테이너</h3>{selected.containers.length ? <ul>{selected.containers.map(container => <li key={container.id}><strong>{container.name || container.id.slice(0, 12)}</strong> · {container.state}</li>)}</ul> : <p className="muted">참조하는 컨테이너가 없습니다.</p>}
          <details style={{ margin: '16px 0' }}><summary>레이블과 드라이버 옵션</summary><pre className="logs" style={{ maxHeight: 220, whiteSpace: 'pre-wrap' }}>{JSON.stringify({ labels: selected.labels, options: selected.options }, null, 2)}</pre></details>
          <h3 style={{ margin: '18px 0 10px' }}>볼륨 복제</h3><form onSubmit={event => { event.preventDefault(); void clone(selected); }}><div className="field"><label htmlFor="volume-clone-name">새 볼륨 이름</label><input id="volume-clone-name" className="text-input" value={cloneName} onChange={event => setCloneName(event.target.value)} maxLength={128} disabled={busy || !selected.fileSupported} placeholder={`${selected.name}-copy`} spellCheck={false} /></div><button className="button small" style={{ marginTop: 8 }} disabled={busy || !cloneName.trim() || !selected.fileSupported || selected.activeReferences > 0}>새 볼륨으로 복제</button></form>
          <div className="field" style={{ marginTop: 18 }}><label htmlFor="volume-import-mode">tar 가져오기 방식</label><select id="volume-import-mode" className="text-input" value={importMode} disabled={busy || !selected.fileSupported} onChange={event => setImportMode(event.target.value as 'merge' | 'replace')}><option value="merge">병합 · 같은 경로 파일 덮어쓰기</option><option value="replace">전체 교체 · 기존 파일 삭제 후 가져오기</option></select></div>
          <div className="detail-actions" style={{ marginTop: 16, flexWrap: 'wrap' }}><button className="button small" disabled={busy || !selected.fileSupported || selected.activeReferences > 0} onClick={() => void exportArchive(selected)}><Icon name="download" size={14} />tar 내보내기</button><button className="button small" disabled={busy || !selected.fileSupported} onClick={() => void importArchive(selected)}>tar 가져오기…</button><button className="button small danger-button" disabled={busy || !selected.fileSupported} onClick={() => void prepare('empty', selected)}>비우기…</button><button className="button small danger-button" disabled={busy} onClick={() => void prepare('delete', selected)}>삭제…</button></div>
        </div>}</DetailPanel>}
      </div>}
    </EngineGate>
    {target && <ConfirmDialog title={`${labels[target.kind]} 확인`} label={`${labels[target.kind]} 실행`} busy={executing} ready={!validating && !!preview?.eligible && !!preview.token} error={dialogError} acknowledged={acknowledged} onAcknowledge={setAcknowledged} onCancel={cancel} onConfirm={() => void execute()}>
      <p>대상 볼륨</p><div className="dialog-target mono">{target.volume.name}</div>
      {target.kind === 'import' && <p>가져오기 방식: <strong>{target.mode === 'merge' ? '병합' : '전체 교체'}</strong></p>}
      <p>{preview?.impact ?? { delete: '볼륨과 저장된 파일을 삭제합니다.', empty: '볼륨은 남기고 안의 파일을 모두 삭제합니다.', import: target.mode === 'merge' ? 'tar와 경로가 같은 파일을 덮어쓰고 나머지 파일은 유지합니다.' : '기존 파일과 폴더를 모두 삭제한 뒤 tar 파일을 가져옵니다.' }[target.kind]}</p>
      {validating && <p className="loading-line" role="status">볼륨과 컨테이너 참조를 검사하고 있습니다.</p>}
      {preview && <>
        {preview.summary && <p>현재 파일·폴더 {preview.summary.entries.toLocaleString()}개 · {formatBytes(preview.summary.bytes)}</p>}
        {preview.archive && <><div className="dialog-target mono">{preview.archive.path}</div><p>가져올 파일·폴더 {preview.archive.entries.toLocaleString()}개 · {formatBytes(preview.archive.bytes)}</p></>}
        {preview.importPlan && <>
          {preview.mode === 'replace' ? <p className="danger">기존 항목 {preview.importPlan.removedEntries.toLocaleString()}개 · {formatBytes(preview.importPlan.removedBytes)} 삭제 후 가져옵니다.</p> : <p>기존 파일 {preview.importPlan.overwrittenFiles.toLocaleString()}개 덮어쓰기 · 새 파일 {preview.importPlan.createdFiles.toLocaleString()}개 추가</p>}
          {preview.importPlan.overwrittenPaths.length > 0 && <details><summary>덮어쓸 파일 경로</summary><ul className="mono selectable" style={{ maxHeight: 180, overflowY: 'auto', overflowWrap: 'anywhere' }}>{preview.importPlan.overwrittenPaths.map(path => <li key={path}>{path}</li>)}</ul>{preview.importPlan.overwrittenPathsTruncated && <p className="usage-note">처음 50개 경로를 표시했습니다.</p>}</details>}
        </>}
        {preview.references.length > 0 && <ul>{preview.references.map(container => <li key={container.id}>{container.name || container.id} · {container.state}</li>)}</ul>}
        {preview.blockedReasons.map(reason => <p className="danger" key={reason}>{reason}</p>)}
        {preview.warnings.map(warning => <p className="usage-note" key={warning}>{warning}</p>)}
        {preview.expiresAt && <p className="usage-note">승인 만료: {new Date(preview.expiresAt).toLocaleTimeString()}</p>}
      </>}
    </ConfirmDialog>}
  </>;
}
