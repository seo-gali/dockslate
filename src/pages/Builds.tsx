import { ResizableTable } from '../ResizableColumns';
import { TableFilters, useTableRows } from '../TableRows';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EngineProps } from '../App';
import { backend, refreshDashboardAfterMutation, useBackendQuery } from '../api';
import type { useImageBuild } from '../ImageBuild';
import { ImageBuildPanel } from '../ImageBuildPanel';
import type { useComposeImport } from '../ComposeImport';
import { ComposeImportPanel } from '../ComposeImportPanel';
import { OperationNotice, type Operation } from '../actions';
import { ConfirmDialog, DetailPanel, ErrorNotice, Icon, PageHeader, Pagination, SearchInput, StatePanel, StatusBadge, TaskProgress, errorMessage } from '../components';
import { getLocale, t } from "../i18n";


interface BuildRecord { id?: string; ref: string; name: string; status: string; createdAt: string | null; completedAt: string | null; totalSteps: number | null; cachedSteps: number | null; source?: string }
interface BuilderNode { name: string; endpoint: string; status: string | number | null; version: string | null; platforms: string[]; error?: string | null }
interface Builder { name: string; driver: string; current: boolean; nodes: BuilderNode[]; platforms: string[]; error?: string | null; lastActivity?: string | null }
interface History { builder: string; state: 'ready' | 'unsupported' | 'error' | 'unavailable'; records: BuildRecord[]; message: string }
interface Transfer { id: string; state: 'running' | 'completed' | 'failed'; kind: string; path: string; message: string }
interface Snapshot { version: string; selectedBuilder: string; selectionError?: string | null; builders: Builder[]; history: History; imported: BuildRecord[]; transfer: Transfer | null }
interface RecordDetail { details: Record<string, unknown>; logs: string; truncated: boolean; source?: string }
interface BuilderRequest { action: 'create' | 'use' | 'remove' | 'update'; name: string; driver?: string; endpoint?: string; platforms?: string[]; node?: string }
interface TransferRequest { kind: 'import' | 'export'; path: string; builder?: string; reference?: string; importedId?: string }
type Approval = { kind: 'builder'; title: string; target: string; impact: string; request: BuilderRequest } | { kind: 'transfer'; title: string; target: string; impact: string; request: TransferRequest };
const date = (value?: string | null) => value ? new Date(value).toLocaleString(getLocale()) : t("기록 없음");
const activeStatus = (status: string) => /^(running|building|pending|queued|in[\s_-]?progress)$/i.test(status?.trim() ?? '');
const statusTone = (status: string) => /error|failed|canceled/i.test(status) ? 'danger' as const : activeStatus(status) ? 'accent' as const : /^(completed|success|succeeded)$/i.test(status) ? 'success' as const : 'muted' as const;
const statusText = (status: string) => /error|failed/i.test(status) ? t("실패") : /canceled/i.test(status) ? t("취소됨") : /^(pending|queued)$/i.test(status) ? t("대기 중") : activeStatus(status) ? t("진행 중") : /^(completed|success|succeeded)$/i.test(status) ? t("완료") : status || t("미확인");

export default function Builds(props: EngineProps & { build: ReturnType<typeof useImageBuild>; compose: ReturnType<typeof useComposeImport>; importBlocked?: boolean; onBusy?: (value: boolean) => void }) {
  const query = useBackendQuery<Snapshot>('builds_snapshot');
  const [tab, setTab] = useState<'source' | 'active' | 'history' | 'builders' | 'imported'>('source');
  const [showBuild, setShowBuild] = useState(false);
  useEffect(() => { if (props.compose.busy || props.compose.preview) setTab('source'); }, [props.compose.busy, props.compose.preview?.token]);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const term = search.trim().toLowerCase();
  const [builder, setBuilder] = useState('');
  const [history, setHistory] = useState<History | null>(null);
  const [reading, setReading] = useState(false);
  const [selected, setSelected] = useState<BuildRecord | null>(null);
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailCache = useRef({ values: new Map<string, { data: RecordDetail; bytes: number }>(), bytes: 0 });
  const detailRequests = useRef(new Map<string, Promise<RecordDetail>>());
  const generation = useRef(0);
  const [selectedBuilder, setSelectedBuilder] = useState<Builder | null>(null);
  const [builderDetails, setBuilderDetails] = useState<string | null>(null);
  const builderCache = useRef(new Map<string, string>());
  const builderRequests = useRef(new Map<string, Promise<{ output: string }>>());
  const builderGeneration = useRef(0);
  const [showBuilder, setShowBuilder] = useState(false);
  const [name, setName] = useState('');
  const [driver, setDriver] = useState('docker-container');
  const [endpoint, setEndpoint] = useState('');
  const [platforms, setPlatforms] = useState('');
  const [node, setNode] = useState('');
  const [editPlatforms, setEditPlatforms] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [picking, setPicking] = useState(false);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const transferRequest = useRef(false);
  const completedTransfers = useRef(new Set<string>());
  const [approval, setApproval] = useState<Approval | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [working, setWorking] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation>(null);
  const request = useRef(false);
  const transferBusy = transfer?.state === 'running';
  const busy = working || picking || transferBusy || props.build.busy || !!props.mutationBlocked;
  const selectedHistory = history ?? query.data?.history;
  const visibleHistory = tab === 'active' ? query.data?.history : selectedHistory;
  const engineScope = JSON.stringify([props.engine?.state, props.engine?.context, props.engine?.endpoint, props.engine?.engine, props.engine?.ownerPath]);
  useEffect(() => { if (props.build.job?.id) setShowBuild(true); }, [props.build.job?.id]);
  useEffect(() => {
    const cleanup = () => {
      generation.current += 1; builderGeneration.current += 1;
    detailCache.current = { values: new Map(), bytes: 0 }; detailRequests.current = new Map(); builderCache.current = new Map(); builderRequests.current = new Map();
    };
    cleanup();
    setSelected(null); setDetail(null); setDetailLoading(false); setDetailError(null); setSelectedBuilder(null); setBuilderDetails(null); setHistory(null); setReading(false);
    if (!query.data) return cleanup;
    setBuilder(query.data.selectedBuilder);
    if (query.data.transfer) {
      if (query.data.transfer.state !== 'running') completedTransfers.current.add(query.data.transfer.id);
      setTransfer(current => !current || current.id === query.data!.transfer!.id ? query.data!.transfer : current);
    }
    return cleanup;
  }, [query.data, query.revision, engineScope]);
  useEffect(() => { props.onBusy?.(working || transferBusy); }, [working, transferBusy, props.onBusy]);
  useEffect(() => {
    if (!transfer || transfer.state !== 'running') return;
    const timer = window.setInterval(() => {
      if (transferRequest.current) return;
      transferRequest.current = true;
      void backend<Transfer>('builds_transfer_status', { id: transfer.id }).then(value => setTransfer(current => current?.id === value.id ? value : current)).catch(failure => setOperation({ tone: 'danger', message: errorMessage(failure) })).finally(() => { transferRequest.current = false; });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [transfer?.id, transfer?.state]);
  useEffect(() => {
    if (!transfer || transfer.state === 'running' || completedTransfers.current.has(transfer.id)) return;
    completedTransfers.current.add(transfer.id);
    setOperation({ tone: transfer.state === 'completed' ? 'success' : 'danger', message: transfer.message });
    void refreshDashboardAfterMutation();
  }, [transfer]);
  const chooseApproval = (value: Approval) => { setApproval(value); setAcknowledged(false); setApprovalError(null); };
  const confirm = async () => {
    if (!approval || !acknowledged || request.current) return;
    request.current = true; setWorking(true); setApprovalError(null);
    try {
      if (approval.kind === 'builder') {
        const result = await backend<{ message: string }>('builds_builder_change', { request: approval.request, approved: true });
        setOperation({ tone: 'success', message: result.message }); setShowBuilder(false); setSelectedBuilder(null);
        await refreshDashboardAfterMutation();
      } else setTransfer(await backend<Transfer>('builds_transfer_start', { request: approval.request, approved: true }));
      setApproval(null); setAcknowledged(false);
    } catch (failure) { setApprovalError(errorMessage(failure)); }
    finally { request.current = false; setWorking(false); }
  };
  const readHistory = async () => {
    if (!builder || reading) return;
    const cache = detailCache.current;
    setReading(true); setSelected(null); setDetail(null); setOperation(null);
    try { const result = await backend<History>('builds_history_list', { builder }); if (detailCache.current === cache) setHistory(result); }
    catch (failure) { if (detailCache.current === cache) setOperation({ tone: 'danger', message: errorMessage(failure) }); }
    finally { if (detailCache.current === cache) setReading(false); }
  };
  const openRecord = async (record: BuildRecord) => {
    const key = record.id ?? `${visibleHistory?.builder}/${record.ref}`; const current = ++generation.current;
    const cache = detailCache.current, pending = detailRequests.current, cached = cache.values.get(key);
    setSelected(record); setDetailError(null); setDetail(cached?.data ?? null);
    if (cached) { cache.values.delete(key); cache.values.set(key, cached); setDetailLoading(false); return; }
    setDetailLoading(true);
    try {
      let request = pending.get(key);
      if (!request) {
        request = backend<RecordDetail>('builds_history_detail', { builder: visibleHistory?.builder ?? builder, reference: record.ref, importedId: record.id ?? null }).then(data => {
          const bytes = JSON.stringify(data).length * 2;
          if (detailCache.current === cache && bytes <= 2 * 1024 * 1024) {
            cache.values.set(key, { data, bytes }); cache.bytes += bytes;
            while (cache.bytes > 8 * 1024 * 1024 || cache.values.size > 24) {
              const first = cache.values.keys().next().value!;
              cache.bytes -= cache.values.get(first)!.bytes; cache.values.delete(first);
            }
          }
          return data;
        }).finally(() => pending.delete(key));
        pending.set(key, request);
      }
      const result = await request;
      if (generation.current === current) setDetail(result);
    } catch (failure) { if (generation.current === current) setDetailError(errorMessage(failure)); }
    finally { if (generation.current === current) setDetailLoading(false); }
  };
  const inspectBuilder = async (value: Builder) => {
    const current = ++builderGeneration.current, cache = builderCache.current, pending = builderRequests.current;
    setSelectedBuilder(value); setNode(value.nodes[0]?.name ?? ''); setEditPlatforms(value.platforms.join(', '));
    const cached = cache.get(value.name);
    setBuilderDetails(cached ?? null);
    if (cached !== undefined) { cache.delete(value.name); cache.set(value.name, cached); return; }
    try {
      let request = pending.get(value.name);
      if (!request) {
        request = backend<{ output: string }>('builds_builder_inspect', { name: value.name }).finally(() => pending.delete(value.name));
        pending.set(value.name, request);
      }
      const result = await request;
      if (builderCache.current === cache && result.output.length * 2 <= 512 * 1024) {
        cache.delete(value.name); cache.set(value.name, result.output);
        let bytes = [...cache.values()].reduce((sum, output) => sum + output.length * 2, 0);
        while (bytes > 2 * 1024 * 1024 || cache.size > 24) {
          const first = cache.keys().next().value!;
          bytes -= cache.get(first)!.length * 2; cache.delete(first);
        }
      }
      if (builderGeneration.current === current) setBuilderDetails(result.output);
    } catch (failure) { if (builderGeneration.current === current) setBuilderDetails(errorMessage(failure)); }
  };
  const pick = async (save: boolean) => {
    setPicking(true); setOperation(null);
    try { return (await backend<{ path: string | null }>('builds_pick_file', { save })).path; }
    catch (failure) { setOperation({ tone: 'danger', message: errorMessage(failure) }); return null; }
    finally { setPicking(false); }
  };
  const exportRecord = async (record: BuildRecord) => {
    const path = await pick(true); if (!path) return;
    chooseApproval({ kind: 'transfer', title: t("빌드 기록 내보내기"), target: path, impact: record.id ? t("보관한 원본 파일을 새 파일로 복사합니다. 파일에 여러 기록이 있으면 함께 내보냅니다.") : t("선택한 빌드의 설정, 로그와 첨부 기록을 파일에 저장합니다. 이미지와 빌드 캐시는 변경하지 않습니다."), request: { kind: 'export', path, builder: selectedHistory?.builder ?? builder, reference: record.ref, importedId: record.id } });
  };
  const recordMatches = useMemo(() => (tab === 'imported' ? query.data?.imported ?? [] : visibleHistory?.records ?? []).filter(record => (tab !== 'active' || activeStatus(record.status)) && (!term || `${record.name} ${record.ref} ${record.status}`.toLowerCase().includes(term))), [tab, query.data?.imported, visibleHistory, term]);
  const historyRows = useTableRows(recordMatches, [{ value: record => record.name || record.ref }, { value: record => record.status, enum: true, label: statusText }, { value: record => record.createdAt ? Date.parse(record.createdAt) : null }, { value: record => record.totalSteps }, null]);
  const records = historyRows.rows;
  const builderRows = useTableRows(query.data?.builders ?? [], [{ value: builder => builder.name }, { value: builder => builder.driver, enum: true }, { value: builder => builder.platforms.join(', ') }, null]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(records.length / 50) - 1));
  const visibleRecords = useMemo(() => records.slice(currentPage * 50, (currentPage + 1) * 50), [records, currentPage]);
  useEffect(() => { setPage(0); }, [search, tab, builder, historyRows.revision]);
  const createBuilder = () => chooseApproval({ kind: 'builder', title: t("빌더 만들기"), target: `${name.trim()} · ${driver}${driver === 'remote' ? ` · ${endpoint.trim()}` : t(" · DockSlate 엔진")}`, impact: driver === 'remote' ? t("지정한 원격 BuildKit에 연결하는 빌더를 등록합니다. 이 빌더를 선택해 빌드하면 소스가 해당 서버에 전송됩니다.") : t("DockSlate 엔진용 사용자 빌더를 등록합니다. 첫 빌드에서 BuildKit 이미지 다운로드와 컨테이너 생성이 필요할 수 있습니다. 지금은 빌드를 시작하지 않습니다."), request: { action: 'create', name: name.trim(), driver, endpoint: endpoint.trim(), platforms: platforms.split(',').map(value => value.trim()).filter(Boolean) } });

  return <><PageHeader title={t("Builds")}><button className="button" disabled={busy} onClick={() => setShowImport(value => !value)}>{t("기록 가져오기")}</button></PageHeader>
    <OperationNotice operation={operation} onDismiss={() => setOperation(null)} />
        <div className="page-tabs" role="tablist" aria-label={t("빌드 보기")}>{([['source', t('파일에서 빌드')], ['active', t("진행 중")], ['history', t("빌드 기록")], ['builders', t("빌더")], ['imported', t("가져온 기록")]] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => { setTab(value); setSelected(null); setDetail(null); generation.current += 1; }}>{label}</button>)}</div>
    {transferBusy && <div className="operation-banner accent" role="status"><Icon name="refresh" /><span>{transfer?.message} · {transfer?.path}</span></div>}
    <div hidden={tab !== 'source'}><ComposeImportPanel compose={props.compose} connected={props.engine?.state === 'connected'} blocked={working || transferBusy || props.importBlocked} />
    {(showBuild || props.build.busy) && <ImageBuildPanel build={props.build} connected={props.engine?.state === 'connected'} blocked={working || transferBusy || props.compose.busy} onClose={() => setShowBuild(false)} />}</div>
    <div className="list-pane" hidden={tab === 'source'}>
      {query.error && <ErrorNotice message={query.error} onRetry={() => void props.reloadEngine()} />}
      {showImport && <section className="panel" aria-label={t("빌드 기록 가져오기")} style={{ marginBottom: 20 }}><h2>{t("빌드 기록 가져오기")}</h2><p className="usage-note">{t(".dockerbuild 파일의 실제 기록과 로그를 DockSlate에 보관합니다. 엔진에 이미지나 빌드 캐시를 복원하지 않습니다.")}</p><div className="toolbar"><input className="text-input mono" aria-label={t("가져올 빌드 기록 파일")} value={importPath} disabled={busy} onChange={event => setImportPath(event.target.value)} placeholder={t(".dockerbuild 파일 경로")} /><button className="button" disabled={busy} onClick={() => void pick(false).then(path => { if (path) setImportPath(path); })}>{t("파일 선택")}</button><button className="button primary" disabled={busy || !importPath.trim()} onClick={() => chooseApproval({ kind: 'transfer', title: t("빌드 기록 가져오기"), target: importPath.trim(), impact: t("선택한 파일의 설정과 로그를 앱 보관함으로 가져옵니다. 엔진과 기존 기록은 변경하지 않습니다. 압축 파일은 64MB, 보관 기록은 200개까지 지원합니다."), request: { kind: 'import', path: importPath.trim() } })}>{t("가져오기")}</button></div></section>}
      {query.loading && !query.data ? <StatePanel busy title={t("빌드 정보 조회 중")} /> : query.data && <>
        <div className="section-heading"><p className="usage-note" style={{ margin: 0 }}>{t("선택한 빌더") + " "}<strong>{query.data.selectedBuilder || t("선택 필요")}</strong></p>{props.build.job && <StatusBadge tone={props.build.job.state === 'running' ? 'accent' : props.build.job.state === 'failed' ? 'danger' : 'muted'}>{props.build.job.state === 'running' ? t("진행 중인 빌드 1개") : t("최근 앱 빌드 {p1}", { p1: (props.build.job.state === 'completed' ? t("완료") : t("실패")) })}</StatusBadge>}</div>
        {tab !== 'builders' ? <>
          {tab === 'active' && props.build.job?.state === 'running' && <p className="build-active-summary" role="status"><strong>{props.build.job.tag}</strong> · {props.build.job.builder || t("확인 중")}</p>}
          <div className="toolbar"><SearchInput value={search} onChange={setSearch} placeholder={t("빌드 이름, ID, 상태 검색…")} />{tab === 'history' && <><select className="text-input" aria-label={t("기록을 조회할 빌더")} value={builder} disabled={reading || busy} onChange={event => setBuilder(event.target.value)}>{query.data.builders.map(value => <option key={value.name} value={value.name}>{value.name}</option>)}</select><button className="button" disabled={reading || busy || !builder} onClick={() => void readHistory()}>{reading ? t("조회 중…") : t("기록 조회")}</button></>}</div>
          {(tab === 'history' || tab === 'active') && visibleHistory?.state === 'unavailable' ? <StatePanel icon="images" title={t("엔진이 실행되지 않았습니다")} description={t("런타임을 시작하면 엔진의 빌드 기록과 빌더를 조회할 수 있습니다. 가져온 파일의 기록은 지금도 사용할 수 있습니다.")}><button className="button" onClick={props.openRuntimeSettings}>{t("엔진 설정")}</button></StatePanel> : (tab === 'history' || tab === 'active') && visibleHistory && visibleHistory.state !== 'ready' ? <StatePanel icon="images" title={visibleHistory.state === 'unsupported' ? t("이 빌더는 기록 조회를 지원하지 않습니다") : t("빌드 기록을 조회하지 못했습니다")} description={visibleHistory.message}><button className="button" disabled={reading || busy} onClick={() => void (tab === 'active' ? props.reloadEngine() : readHistory())}>{t("다시 조회")}</button></StatePanel> : recordMatches.length === 0 ? <StatePanel icon="images" title={term ? t("검색 결과가 없습니다") : tab === 'imported' ? t("가져온 빌드 기록이 없습니다") : tab === 'active' ? t("조회된 진행 중 빌드가 없습니다") : t("저장된 빌드 기록이 없습니다")} description={tab === 'imported' ? t("기록 가져오기에서 .dockerbuild 파일을 선택하세요.") : tab === 'active' ? t("BuildKit의 진행 상태는 전체 새로고침 시 갱신합니다.") : t("빌드가 완료되면 선택한 빌더가 보관한 실제 기록을 확인할 수 있습니다.")} /> : <div className={`split-view ${selected ? 'with-detail' : ''}`}><div className="list-pane"><TableFilters controls={historyRows} labels={{1:t("상태")}} /><div className="table-wrap"><ResizableTable storageKey="build-history" controls={historyRows} widths={[560,90,210,100,110]} className="data-table" aria-label={tab === 'active' ? t("BuildKit에서 진행 중인 빌드") : t("빌드 기록")}><thead><tr><th>{t("빌드 이름 / ID")}</th><th>{t("상태")}</th><th style={{ minWidth: 190 }}>{t("시작")}</th><th>{t("단계 / 캐시")}</th><th>{t("작업")}</th></tr></thead><tbody>{visibleRecords.map(record => <tr key={record.id ?? record.ref} className={selected === record ? 'selected' : ''}><td><button className="name-button" onClick={() => void openRecord(record)}>{record.name || record.ref}</button><span className="cell-subtext" >{record.ref}</span></td><td><StatusBadge tone={statusTone(record.status)}>{statusText(record.status)}</StatusBadge></td><td className="date-cell">{date(record.createdAt)}</td><td>{record.totalSteps ?? t("미확인")} / {record.cachedSteps ?? t("미확인")}</td><td><button className="button small" disabled={busy || activeStatus(record.status)} onClick={() => void exportRecord(record)}>{t("내보내기")}</button></td></tr>)}</tbody></ResizableTable></div><Pagination page={currentPage} count={records.length} onPage={setPage} /></div>{selected && <DetailPanel title={selected.name || selected.ref} onClose={() => { generation.current += 1; setSelected(null); }}><div className="detail-content">{detailLoading && <p role="status">{t("실제 빌드 설정과 로그를 읽고 있습니다.")}</p>}{detailError && <ErrorNotice message={detailError} onRetry={() => void openRecord(selected)} />}{detail && <><p className="usage-note">{selected.id ? t("가져온 파일의 기록") : t("BuildKit 기록")} · {detail.truncated ? t("일부 로그만 표시") : t("저장된 로그")}</p><pre className="logs" aria-label={t("빌드 기록 로그")} tabIndex={0}>{detail.logs || t("이 기록에 저장된 로그가 없습니다.")}</pre><details style={{ marginTop: 16 }}><summary>{t("빌드 설정 보기")}</summary><pre className="logs" aria-label={t("빌드 기록 설정")} tabIndex={0}>{JSON.stringify(detail.details, null, 2)}</pre></details></>}</div></DetailPanel>}</div>}
          {tab === 'history' && selectedHistory?.message && selectedHistory.state === 'ready' && <p className="usage-note">{selectedHistory.message}</p>}
        </> : props.engine?.state !== 'connected' ? <StatePanel icon="images" title={t("빌더를 조회하려면 엔진을 시작하세요")}><button className="button" onClick={props.openRuntimeSettings}>{t("엔진 설정")}</button></StatePanel> : <>
          <div className="section-heading"><p>{t("조회와 상세 보기는 빌더를 시작하지 않습니다.")}</p><button className="button primary" disabled={busy} onClick={() => setShowBuilder(value => !value)}>{t("빌더 만들기")}</button></div>
          {showBuilder && <section className="panel" style={{ marginBottom: 20 }} aria-label={t("빌더 만들기")}><h2>{t("빌더 만들기")}</h2><div className="toolbar"><div className="field"><label htmlFor="builder-name">{t("빌더 이름")}</label><input id="builder-name" className="text-input" value={name} disabled={busy} onChange={event => setName(event.target.value)} maxLength={64} /></div><div className="field"><label htmlFor="builder-driver">{t("드라이버")}</label><select id="builder-driver" className="text-input" value={driver} disabled={busy} onChange={event => setDriver(event.target.value)}><option value="docker-container">{t("DockSlate의 BuildKit 컨테이너")}</option><option value="remote">{t("기존 원격 BuildKit")}</option></select></div></div>{driver === 'remote' && <div className="field"><label htmlFor="builder-endpoint">{t("BuildKit 주소")}</label><input id="builder-endpoint" className="text-input mono" value={endpoint} disabled={busy} onChange={event => setEndpoint(event.target.value)} placeholder="tcp://build-server:1234" maxLength={512} /><p className="usage-note">{t("인증 정보가 없는 TCP 또는 WSL 내부 Unix 소켓을 지원합니다. TLS·SSH·Kubernetes는 이 화면에서 구성하지 않습니다.")}</p></div>}<div className="field"><label htmlFor="builder-platforms">{t("플랫폼 · 쉼표로 구분, 비우면 자동 확인")}</label><input id="builder-platforms" className="text-input" value={platforms} disabled={busy} onChange={event => setPlatforms(event.target.value)} placeholder="linux/amd64, linux/arm64" /></div><button className="button primary" style={{ marginTop: 14 }} disabled={busy || !name.trim() || (driver === 'remote' && !endpoint.trim())} onClick={createBuilder}>{t("대상 확인")}</button></section>}
          <TableFilters controls={builderRows} labels={{1:t("드라이버")}} /><div className="table-wrap"><ResizableTable storageKey="builders" controls={builderRows} widths={[280,140,500,140]} className="data-table" aria-label={t("빌더 목록")}><thead><tr><th>{t("빌더")}</th><th>{t("드라이버")}</th><th>{t("플랫폼")}</th><th>{t("작업")}</th></tr></thead><tbody>{builderRows.rows.map(value => <tr key={value.name}><td><div className="builder-name"><button className="name-button" onClick={() => void inspectBuilder(value)}>{value.name}</button>{value.current && <StatusBadge tone="accent">{t("선택됨")}</StatusBadge>}</div>{value.error && <span className="cell-subtext danger">{value.error}</span>}</td><td>{value.driver}</td><td style={{ whiteSpace: 'normal' }}>{value.platforms.join(', ') || t("빌더가 보고한 플랫폼 없음")}</td><td><div className="header-actions"><button className="button small" disabled={busy || value.current} onClick={() => chooseApproval({ kind: 'builder', title: t("기본 빌더 변경"), target: value.name, impact: t("이 앱에서 다음 이미지 빌드부터 사용할 빌더를 선택합니다. 원격 노드에는 빌드 소스가 전송됩니다. 앱을 다시 시작하면 DockSlate의 로컬 기본 빌더를 사용합니다."), request: { action: 'use', name: value.name } })}>{t("선택")}</button>{value.driver !== 'docker' && value.name !== 'default' && <button className="button small danger-button" disabled={busy} onClick={() => chooseApproval({ kind: 'builder', title: t("빌더 등록 삭제"), target: value.name, impact: t("선택한 빌더의 등록을 삭제합니다. 실행 중인 BuildKit 데몬과 보관 상태는 유지합니다."), request: { action: 'remove', name: value.name } })}>{t("삭제")}</button>}</div></td></tr>)}</tbody></ResizableTable></div>
          {selectedBuilder && <section className="panel" style={{ marginTop: 20 }} aria-label={t("빌더 상세")}><div className="section-heading"><h2>{selectedBuilder.name}</h2><button className="icon-button" onClick={() => setSelectedBuilder(null)} aria-label={t("빌더 상세 닫기")}><Icon name="close" /></button></div><dl className="detail-meta"><dt>{t("드라이버")}</dt><dd>{selectedBuilder.driver}</dd><dt>{t("최근 작업")}</dt><dd>{date(selectedBuilder.lastActivity)}</dd>{selectedBuilder.nodes.map(value => <div key={value.name}><dt>{value.name}</dt><dd className="mono">{value.endpoint} · {String(value.status ?? t("상태 정보 없음"))}</dd></div>)}</dl><details><summary>{t("실제 빌더 검사 결과")}</summary><pre className="logs" aria-label={t("빌더 검사 결과")}>{builderDetails ?? t("검사 결과를 읽고 있습니다.")}</pre></details>{selectedBuilder.driver !== 'docker' && <div style={{ marginTop: 16 }}><div className="toolbar"><select className="text-input" aria-label={t("플랫폼을 변경할 노드")} value={node} disabled={busy} onChange={event => setNode(event.target.value)}>{selectedBuilder.nodes.map(value => <option key={value.name} value={value.name}>{value.name}</option>)}</select><input className="text-input" aria-label={t("노드 플랫폼")} value={editPlatforms} disabled={busy} onChange={event => setEditPlatforms(event.target.value)} placeholder="linux/amd64, linux/arm64" /><button className="button" disabled={busy || !node || !editPlatforms.trim()} onClick={() => chooseApproval({ kind: 'builder', title: t("빌더 플랫폼 변경"), target: `${selectedBuilder.name} · ${node}`, impact: t("선택한 노드가 사용할 플랫폼 설정을 변경합니다. CPU 에뮬레이터를 설치하거나 새 빌드를 시작하지 않습니다."), request: { action: 'update', name: selectedBuilder.name, node, platforms: editPlatforms.split(',').map(value => value.trim()).filter(Boolean) } })}>{t("플랫폼 변경")}</button></div></div>}</section>}
        </>}
      </>}
    </div>
    {approval && <ConfirmDialog title={approval.title} label={t("실행")} busy={working} error={approvalError} acknowledged={acknowledged} onAcknowledge={setAcknowledged} onCancel={() => { if (!working) setApproval(null); }} onConfirm={() => void confirm()}><ul className="dialog-target-list"><li>{approval.target}</li></ul><p>{approval.impact}</p>{approval.kind === 'builder' && approval.request.platforms?.length ? <p>{t("플랫폼:") + " "}{approval.request.platforms.join(', ')}</p> : null}</ConfirmDialog>}
  </>;
}
