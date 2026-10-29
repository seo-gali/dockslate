import { t, getLocale } from '../i18n';
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
const Logs = lazy(() => import('../ContainerLogs'));
const ContainerEdit = lazy(() => import('../ContainerEdit'));
import { ResizableTable, type ResizableColumn } from '../ResizableColumns';
import { TableFilters, useTableRows } from '../TableRows';
import { connectionAddress, webPort } from '../containerPorts';
import { ContainerDialog } from '../ContainerDialog';
const ContainerInspect = lazy(() => import('../ContainerInspect').then(module => ({ default: module.ContainerInspect })));
const ContainerFiles = lazy(() => import('../ContainerFiles').then(module => ({ default: module.ContainerFiles })));
const ContainerTerminal = lazy(() => import('../ContainerTerminal').then(module => ({ default: module.ContainerTerminal })));
import { ContainerStats } from '../ContainerStats';
import { ContainerUsage, metricText } from '../ContainerUsage';
import { createPortal } from 'react-dom';
import { EngineGate, type EngineProps, type ContainerOpenRequest } from '../App';
import { backend, refreshDashboardAfterMutation, type ContainerActionResult, type Container, type DockerImage, useBackendQuery, useContainerMetrics, type ContainerMetric, updateContainerStatus } from '../api';
import { OperationNotice, useDestructiveAction, type Operation } from '../actions';
import { ErrorNotice, Icon, PageHeader, Pagination, SearchInput, StatePanel, StatusBadge, errorMessage } from '../components';

type ContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'edit' | 'delete';
type DetailTab = 'details' | 'logs' | 'inspect' | 'files' | 'terminal';

function ContainerMenu({ container, busy, onAction, onBrowser }: { container: Container; busy: boolean; onAction: (action: ContainerAction) => void; onBrowser: () => void }) {
  const [position,setPosition]=useState<{top:number;left:number}|null>(null);
  const button=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!position)return;menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node)&&!button.current?.contains(event.target as Node))setPosition(null);};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){setPosition(null);button.current?.focus();}if(event.key==='Tab')setPosition(null);if(event.key==='ArrowDown'||event.key==='ArrowUp'){const items=[...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];event.preventDefault();items[(items.indexOf(document.activeElement as HTMLButtonElement)+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}};
    const close=()=>setPosition(null);window.addEventListener('pointerdown',outside);window.addEventListener('keydown',key);window.addEventListener('resize',close);return()=>{window.removeEventListener('pointerdown',outside);window.removeEventListener('keydown',key);window.removeEventListener('resize',close);};
  },[position]);
  const running=['running','paused','restarting'].includes(container.state);
  const act=(action:ContainerAction)=>{setPosition(null);onAction(action);};
  return <span className="row-menu"><button ref={button} className="icon-button" data-tooltip={t("컨테이너 작업")} aria-label={container.name+' · '+t('작업')} aria-haspopup="menu" aria-expanded={!!position} disabled={busy} onClick={()=>{if(position){setPosition(null);return;}const r=button.current!.getBoundingClientRect();setPosition({top:Math.max(8,Math.min(r.bottom+5,innerHeight-268)),left:Math.max(8,r.right-174)});}}><Icon name="more"/></button>{position&&createPortal(<div ref={menu} className="action-menu container-action-menu" role="menu" style={position}><button role="menuitem" disabled={running} onClick={()=>act('start')}><Icon name="play" size={15}/>{t("시작")}</button><button role="menuitem" disabled={!running} onClick={()=>act('stop')}><Icon name="stop" size={15}/>{t("중지")}</button><button role="menuitem" disabled={!running} onClick={()=>act('restart')}><Icon name="refresh" size={15}/>{t("재시작")}</button><button role="menuitem" disabled={container.state!=='running'||!container.publishedPorts?.some(webPort)} data-tooltip={container.publishedPorts?.some(webPort) ? t("HTTP·HTTPS 서비스 열기") : t("데이터베이스 포트는 전용 클라이언트로 연결하세요.")} onClick={()=>{setPosition(null);onBrowser();}}><Icon name="arrow" size={15}/>{t("브라우저에서 열기")}</button><button role="menuitem" onClick={()=>act('edit')}><Icon name="settings" size={15}/>{t("수정…")}</button><div className="menu-divider"/><button role="menuitem" className="danger" disabled={running} onClick={()=>act('delete')}><Icon name="trash" size={15}/>{t("삭제…")}</button></div>,document.body)}</span>;
}

function detailStatus(container: Container): string {
  const exit = /^Exited \(([-0-9]+)\)/.exec(container.status);
  if (container.state === 'exited' && exit) return Number(exit[1]) === 0 ? t('정상 종료 (코드 0)') : t('오류 종료 (코드 {code})', { code: exit[1] });
  return t(({ running: '실행 중', paused: '일시정지됨', restarting: '재시작 중', created: '생성됨', exited: '중지됨', dead: '오류 종료' } as Record<string,string>)[container.state] ?? container.state);
}

export default function Containers(props: EngineProps & { openRequest?: ContainerOpenRequest | null; onEditBusy: (busy: boolean) => void }) {
  const query = useBackendQuery<Container[]>('containers_list', undefined, props.engine?.state === 'connected');
  const images = useBackendQuery<DockerImage[]>('images_list', undefined, props.engine?.state === 'connected');
  const imageNames = useMemo(() => new Map((images.data ?? []).map(image => [image.id, image.tags[0] ?? image.id])), [images.data]);
  const [search, setSearch] = useState('');
  const [tablePage, setTablePage] = useState(0);
  const [grouped, setGrouped] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const focusCreated = useRef(false);
  const columnSpecs: ResizableColumn[] = [
    {id:'name',width:210,minWidth:120,maxWidth:720}, {id:'status',width:110,minWidth:92,maxWidth:300},
    {id:'image',width:240,minWidth:110,maxWidth:900}, {id:'ports',width:250,minWidth:130,maxWidth:800},
    {id:'cpu',width:90,minWidth:68,maxWidth:250}, {id:'memory',width:125,minWidth:90,maxWidth:350},
    {id:'actions',width:84,minWidth:84,maxWidth:84},
  ];
  const [detailTab, updateDetailTab] = useState<DetailTab>('details');
  const [visitedDetailTabs, setVisitedDetailTabs] = useState(() => new Set<DetailTab>(['details']));
  const setDetailTab = useCallback((tab: DetailTab) => {
    setVisitedDetailTabs(previous => previous.has(tab) ? previous : new Set([...previous, tab]));
    updateDetailTab(tab);
  }, []);
  const [inspectFocus, setInspectFocus] = useState('전체');
  const metrics = useContainerMetrics();
  const metricsById = useMemo(() => new Map(metrics.data?.samples.map(sample => [sample.id, sample]) ?? []), [metrics.data]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const editBusyChanged = useCallback((value: boolean) => { setEditBusy(value); props.onEditBusy(value); }, [props.onEditBusy]);
  const [working, setWorking] = useState(false);
  const [operation, setOperation] = useState<Operation>(null);
  const destructive = useDestructiveAction(() => {});
  const busy = working || editBusy || destructive.busy || !!props.mutationBlocked;
  useEffect(() => {
    if (!props.openRequest) return;
    setSearch(''); containerRows.clearFilters(); setSelectedId(null); setCreatedId(props.openRequest.id); focusCreated.current = true; setTablePage(Math.max(0, Math.floor((query.data?.findIndex(row => row.id === props.openRequest!.id) ?? 0) / 50)));
    setOperation({ tone: props.openRequest.started ? 'success' : 'danger', message: props.openRequest.started ? props.openRequest.name + ' · ' + t('컨테이너를 생성했습니다.') : props.openRequest.message });
  }, [props.openRequest?.sequence]);
  const selected = query.data?.find(container => container.id === selectedId) ?? null;
  useEffect(() => {
    if (!focusCreated.current || !createdId || props.active === false) return;
    const row = document.querySelector<HTMLTableRowElement>('.container-table tr[data-container-id="' + CSS.escape(createdId) + '"]');
    if (row) { row.scrollIntoView({block:'nearest'}); row.querySelector<HTMLButtonElement>('.name-button')?.focus({preventScroll:true}); focusCreated.current = false; }
  }, [createdId, query.data, props.active]);
  const hasCompose = query.data?.some(container => container.composeProject) ?? false;
  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (query.data ?? []).filter(container => {
    return `${container.name} ${container.id} ${container.image} ${imageNames.get(container.image) ?? ''} ${container.composeProject ?? ''}`.toLowerCase().includes(term);
    });
  }, [query.data, search, imageNames]);
  const containerRows = useTableRows(matches, [{ value: container => container.name }, { value: container => container.state, enum: true, label: state => t(({ running: '실행 중', paused: '일시정지됨', restarting: '재시작 중', created: '생성됨', exited: '중지됨', dead: '오류 종료' } as Record<string, string>)[state] ?? state) }, { value: container => imageNames.get(container.image) ?? container.image }, { value: container => container.ports }, { value: container => metricsById.get(container.id)?.cpuPercent }, { value: container => metricsById.get(container.id)?.memoryUsageBytes }, null]);
  const filtered = containerRows.rows;
  const currentPage = Math.min(tablePage, Math.max(0, Math.ceil(filtered.length / 50) - 1));
  const visible = useMemo(() => filtered.slice(currentPage * 50, (currentPage + 1) * 50), [filtered, currentPage]);
  useEffect(() => { setTablePage(0); }, [search, containerRows.revision]);
  const groups = useMemo(() => {
    if (!grouped || !hasCompose) return [['', visible] as const];
    const values = new Map<string, Container[]>();
    for (const container of visible) { const key = container.composeProject ?? ''; values.set(key, [...(values.get(key) ?? []), container]); }
    return [...values.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visible, grouped, hasCompose]);
  const action = async (container: Container, value: ContainerAction) => {
    if (busy) return;
    if (value === 'edit') { setSelectedId(null); setEditingId(container.id); return; }
    if (value === 'delete') { setOperation(null); await destructive.prepare({ kind: 'container_delete', ids: [container.id] }, [`${container.name} · ${container.id}`]); return; }
    setWorking(true);
    destructive.setOperation(null);
    const actionName = t({ start: '시작', stop: '중지', restart: '재시작', pause: '일시정지', unpause: '다시 진행' }[value]);
    setOperation({ tone: 'accent', message: `${container.name} · ${actionName}…` });
    try {
      const result = await backend<ContainerActionResult>('container_action', { id: container.id, action: value });
      updateContainerStatus(container.id,result.state);
      setOperation({ tone: result.state === 'dead' || (result.state === 'exited' && result.exitCode !== 0) ? 'warning' : 'success', message: result.state === 'exited' && result.exitCode === 0 ? t('명령 실행을 마치고 정상 종료했습니다. 오류가 아닙니다.') : result.state === 'exited' ? t('컨테이너가 오류로 종료되었습니다. 코드 {code}', { code: result.exitCode ?? '?' }) : t('{action} 완료', { action: actionName }) });
    } catch (failure) { setOperation({ tone: 'danger', message: `${actionName}: ${errorMessage(failure)}` }); }
    finally { await refreshDashboardAfterMutation(); setWorking(false); }
  };
  const openBrowser = async (container: Container) => {
    const port = container.publishedPorts?.find(webPort);
    if (!port) return;
    try { await backend('container_open_port', { id: container.id, privatePort: port.privatePort, publicPort: port.publicPort }); }
    catch (failure) {
      const message = errorMessage(failure);
      setOperation({tone: 'danger', message: message.startsWith('This port is normally used by a database') ? t('이 포트는 HTTP·HTTPS 서비스가 아닙니다. 전용 클라이언트로 연결하세요.') : message.startsWith('No HTTP or HTTPS response was detected') ? t('웹 응답을 확인하지 못했습니다. 서비스 시작 상태와 포트를 확인하세요.') : message});
    }
  };
  const rowCallbacks = useRef({ action, openBrowser }); rowCallbacks.current = { action, openBrowser };
  const selectRow = useCallback((container: Container) => { setCreatedId(null); setSelectedId(container.id); setVisitedDetailTabs(new Set(['details'])); setDetailTab('details'); }, [setDetailTab]);
  const actOnRow = useCallback((container: Container, value: ContainerAction) => void rowCallbacks.current.action(container, value), []);
  const browseRow = useCallback((container: Container) => void rowCallbacks.current.openBrowser(container), []);
  const copyPort = useCallback(async (port: NonNullable<Container['publishedPorts']>[number]) => {
    try { const address = connectionAddress(port); await navigator.clipboard.writeText(address); setOperation({tone:'success',message:t('연결 주소를 복사했습니다.') + ' ' + address}); }
    catch (failure) { setOperation({tone:'danger',message:errorMessage(failure)}); }
  }, []);
  return <><PageHeader title={t("Containers")}></PageHeader><OperationNotice operation={operation} onDismiss={() => setOperation(null)} /><OperationNotice operation={destructive.operation} onDismiss={() => destructive.setOperation(null)} /><EngineGate {...props}><ContainerUsage containers={query.data ?? []} /><div className="toolbar"><SearchInput value={search} onChange={setSearch} placeholder={t("이름, 이미지, 프로젝트 검색…")} /><TableFilters controls={containerRows} labels={{1:t("상태")}} />{hasCompose && <label className="checkbox-control"><input type="checkbox" checked={grouped} onChange={event => setGrouped(event.target.checked)} />{t("Compose 그룹")}</label>}</div>{query.error && <ErrorNotice message={query.error} onRetry={() => void query.reload()} />}{query.loading && !query.data ? <StatePanel busy title={t("컨테이너 조회 중")} /> : query.data?.length === 0 ? <StatePanel icon="containers" title={t("컨테이너가 없습니다")} description={t("연결된 Docker Engine에 컨테이너가 없습니다.")} /> : query.data && matches.length === 0 ? <StatePanel icon="search" title={t("검색 결과가 없습니다")} description={t("검색어나 상태 필터를 변경해 보세요.")}><button className="button" onClick={() => { setSearch(''); containerRows.clearFilters(); }}>{t("필터 초기화")}</button></StatePanel> : query.data && <><div className="section-heading"><span className="muted" style={{ fontSize: '0.846154rem' }}>{t('{count}개 컨테이너', { count: filtered.length.toLocaleString(getLocale()) })}</span>{query.loading && <span className="muted" style={{ fontSize: '0.846154rem' }}>{t("목록 갱신 중…")}</span>}</div><div className="container-list"><div className="table-wrap"><ResizableTable storageKey="containers" controls={containerRows} columnSpecs={columnSpecs} className="container-table"><thead><tr>{[{id:'name',label:t('이름')},{id:'status',label:t('상태')},{id:'image',label:t('Image')},{id:'ports',label:t('포트')},{id:'cpu',label:'CPU'},{id:'memory',label:t('메모리')}].map(column => <th key={column.id}>{column.label}</th>)}<th aria-label={t('작업')}/></tr></thead><tbody>{groups.map(([project, containers]) => containers.map((container, index) => <ContainerRows key={container.id} language={props.language} container={container} imageName={imageNames.get(container.image) ?? container.image} metric={metricsById.get(container.id)} showGroup={index === 0 && grouped && hasCompose} project={project} groupCount={containers.length} selected={selectedId === container.id || createdId === container.id} busy={busy || query.loading} onSelect={selectRow} onBrowser={browseRow} onCopyPort={copyPort} onAction={actOnRow} />))}</tbody></ResizableTable></div><Pagination page={currentPage} count={filtered.length} onPage={setTablePage} />{selected && <ContainerDialog key={selected.id} title={selected.name} active={props.active !== false} onClose={() => setSelectedId(null)}><div className="detail-tabs"><div className="segmented"><button className={detailTab === 'details' ? 'active' : ''} aria-pressed={detailTab === 'details'} onClick={() => setDetailTab('details')}>{t('Details')}</button><button className={detailTab === 'logs' ? 'active' : ''} aria-pressed={detailTab === 'logs'} onClick={() => setDetailTab('logs')}>{t("Logs")}</button><button className={detailTab === 'inspect' ? 'active' : ''} aria-pressed={detailTab === 'inspect'} onClick={() => { setInspectFocus('전체'); setDetailTab('inspect'); }}>{t("Inspect")}</button><button onClick={() => { setInspectFocus('Mounts'); setDetailTab('inspect'); }}>{t("Mounts")}</button><button className={detailTab === 'terminal' ? 'active' : ''} aria-pressed={detailTab === 'terminal'} onClick={() => setDetailTab('terminal')}>{t("Terminal")}</button><button className={detailTab === 'files' ? 'active' : ''} aria-pressed={detailTab === 'files'} onClick={() => setDetailTab('files')}>{t("Files")}</button></div></div><div className="detail-pane" hidden={detailTab !== 'inspect'}>{visitedDetailTabs.has('inspect') && <Suspense fallback={<p className="loading-line" role="status">{t('화면을 여는 중…')}</p>}><ContainerInspect key={selected.id} container={selected} revision={query.revision} active={detailTab === 'inspect' && props.active !== false} focusSection={inspectFocus} /></Suspense>}</div><div className="detail-pane" hidden={detailTab !== 'files'}>{visitedDetailTabs.has('files') && <Suspense fallback={<p className="loading-line" role="status">{t('화면을 여는 중…')}</p>}><ContainerFiles key={selected.id} container={selected} revision={query.revision} active={detailTab === 'files' && props.active !== false} /></Suspense>}</div><div className="detail-pane" hidden={detailTab !== 'terminal'}>{visitedDetailTabs.has('terminal') && <Suspense fallback={<p className="loading-line" role="status">{t('화면을 여는 중…')}</p>}><ContainerTerminal key={selected.id} container={selected} active={detailTab === 'terminal' && props.active !== false} /></Suspense>}</div><div className="detail-pane log-pane" hidden={detailTab !== 'logs'}>{visitedDetailTabs.has('logs') && <Suspense fallback={<p className="loading-line" role="status">{t('화면을 여는 중…')}</p>}><Logs key={selected.id} container={selected} revision={query.revision} active={detailTab === 'logs' && props.active !== false}/></Suspense>}</div><div className="detail-pane detail-content" hidden={detailTab !== 'details'}><dl className="detail-meta"><dt>{t("상태")}</dt><dd >{detailStatus(selected)}</dd><dt>ID</dt><dd className="mono">{selected.id}</dd><dt>{t("이미지")}</dt><dd >{imageNames.get(selected.image) ?? selected.image}</dd><dt>{t("포트")}</dt><dd className="mono">{selected.ports || t("없음")}</dd>{selected.composeProject && <><dt>Compose</dt><dd>{selected.composeProject}</dd></>}</dl><ContainerStats container={selected} active={detailTab === 'details' && props.active !== false} embedded /><div className="detail-actions"><button className="button" disabled={busy || query.loading} onClick={() => void action(selected, 'edit')}><Icon name="settings" size={15} />{t("수정…")}</button>{['exited', 'created'].includes(selected.state) && <button className="button" disabled={busy || query.loading} onClick={() => void action(selected, 'start')}><Icon name="play" size={15} />{t("시작")}</button>}{selected.state === 'running' && <><button className="button" disabled={busy || query.loading} onClick={() => void action(selected, 'stop')}><Icon name="stop" size={15} />{t("중지")}</button><button className="button" disabled={busy || query.loading} onClick={() => void action(selected, 'restart')}><Icon name="refresh" size={15} />{t("재시작")}</button></>}<button className="button danger-button" disabled={busy || query.loading || ['running', 'paused'].includes(selected.state)} data-tooltip={['running', 'paused'].includes(selected.state) ? t("컨테이너를 중지한 뒤 삭제할 수 있습니다") : t("컨테이너 삭제 확인")} onClick={() => void action(selected, 'delete')}><Icon name="trash" size={15} />{t("삭제…")}</button></div></div></ContainerDialog>}</div></>}</EngineGate>{destructive.dialog}{editingId && <Suspense fallback={null}><ContainerEdit key={editingId} id={editingId} active={props.active !== false} blocked={!!props.mutationBlocked} onBusy={editBusyChanged} onClose={() => setEditingId(null)} onComplete={result => { setEditingId(null); setCreatedId(result.id); setOperation({ tone: result.retainedContainer ? 'warning' : 'success', message: t(result.message) }); }} /></Suspense>}</>;
}

const ContainerRows = memo(function ContainerRows({ container, imageName, metric, showGroup, project, groupCount, selected, busy, onSelect, onAction, onBrowser, onCopyPort }: { language?: 'ko' | 'en'; container: Container; imageName: string; metric?: ContainerMetric; showGroup: boolean; project: string; groupCount: number; selected: boolean; busy: boolean; onSelect: (container: Container) => void; onAction: (container: Container, action: ContainerAction) => void; onBrowser: (container: Container) => void; onCopyPort: (port: NonNullable<Container['publishedPorts']>[number]) => void }) {
  const running = container.state === 'running';
  const stopped = ['exited', 'created'].includes(container.state);
  const active = ['running', 'paused', 'restarting'].includes(container.state);
  return <>{showGroup && <tr className="group-row"><td colSpan={7}><span className="group-row-label"><Icon name="containers" size={13} />{project ? `Compose · ${project}` : t("단독 컨테이너")}<span className="group-count">{groupCount}</span></span></td></tr>}<tr data-container-id={container.id} className={selected ? 'selected' : ''}><td><button className="name-button" data-tooltip={container.name} onClick={() => onSelect(container)}>{container.name}</button></td><td ><StatusBadge tone={running ? 'success' : stopped ? 'muted' : 'warning'}>{running ? t("Running") : stopped ? t("Stopped") : container.state}</StatusBadge></td><td ><span>{imageName}</span></td><td className="mono" >{container.publishedPorts?.length ? <span className="port-endpoints">{container.publishedPorts.map(port => <button key={port.privatePort + ':' + port.publicPort + ':' + port.protocol + ':' + port.ip} className="inline-link port-endpoint" disabled={busy} onClick={() => onCopyPort(port)} data-tooltip={t('연결 주소 복사') + ': ' + connectionAddress(port)} aria-label={t('연결 주소 복사') + ': ' + connectionAddress(port)}>{'127.0.0.1:' + port.publicPort + ' → ' + port.privatePort + '/' + port.protocol}</button>)}</span> : container.ports || t("없음")}</td><td >{metricText(metric, active).cpu}</td><td >{metricText(metric, active).memory}<span className="cell-subtext">{metricText(metric, active).memoryPercent}</span></td><td className="cell-actions"><button className="icon-button" disabled={busy || (!running && !stopped && container.state !== 'paused')} data-tooltip={running ? t("중지") : container.state === 'paused' ? t("다시 진행") : t("시작")} aria-label={`${container.name} ${running ? '중지' : container.state === 'paused' ? '다시 진행' : '시작'}`} onClick={() => onAction(container, running ? 'stop' : container.state === 'paused' ? 'unpause' : 'start')}><Icon name={running ? 'stop' : 'play'} size={16} /></button><ContainerMenu container={container} busy={busy} onAction={action => onAction(container, action)} onBrowser={() => onBrowser(container)} /></td></tr></>;
});
