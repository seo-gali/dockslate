import { t, getLocale } from '../i18n';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cachedLogs, readContainerLogs } from '../containerReadCache';
import { ContainerDialog } from '../ContainerDialog';
import { ContainerInspect } from '../ContainerInspect';
import { ContainerFiles } from '../ContainerFiles';
import { ContainerTerminal } from '../ContainerTerminal';
import { ContainerStats } from '../ContainerStats';
import { ContainerUsage, metricText } from '../ContainerUsage';
import { createPortal } from 'react-dom';
import { EngineGate, type EngineProps, type ContainerOpenRequest } from '../App';
import { backend, refreshDashboardAfterMutation, type ContainerActionResult, type Container,  useBackendQuery, useContainerMetrics, type ContainerMetric, updateContainerStatus } from '../api';
import { OperationNotice, useDestructiveAction, type Operation } from '../actions';
import { ErrorNotice, Icon, PageHeader, Pagination, RefreshButton, SearchInput, StatePanel, StatusBadge, errorMessage } from '../components';

type ContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'delete';

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
  return <span className="row-menu"><button ref={button} className="icon-button" title={t("컨테이너 작업")} aria-label={container.name+' · '+t('작업')} aria-haspopup="menu" aria-expanded={!!position} disabled={busy} onClick={()=>{if(position){setPosition(null);return;}const r=button.current!.getBoundingClientRect();setPosition({top:Math.max(8,Math.min(r.bottom+5,innerHeight-224)),left:Math.max(8,r.right-174)});}}><Icon name="more"/></button>{position&&createPortal(<div ref={menu} className="action-menu container-action-menu" role="menu" style={position}><button role="menuitem" disabled={running} onClick={()=>act('start')}><Icon name="play" size={15}/>{t("시작")}</button><button role="menuitem" disabled={!running} onClick={()=>act('stop')}><Icon name="stop" size={15}/>{t("중지")}</button><button role="menuitem" disabled={!running} onClick={()=>act('restart')}><Icon name="refresh" size={15}/>{t("재시작")}</button><button role="menuitem" disabled={container.state!=='running'||!container.publishedPorts?.some(p=>p.protocol==='tcp')} onClick={()=>{setPosition(null);onBrowser();}}><Icon name="arrow" size={15}/>{t("브라우저에서 열기")}</button><div className="menu-divider"/><button role="menuitem" className="danger" disabled={running} onClick={()=>act('delete')}><Icon name="trash" size={15}/>{t("삭제…")}</button></div>,document.body)}</span>;
}

function Logs({ container, revision, active }: { container: Container; revision: number; active: boolean }) {
  const [entry, setEntry] = useState(() => cachedLogs(container.id));
  const [loading, setLoading] = useState(!entry), [error,setError] = useState<string | null>(null);
  const [search,setSearch] = useState(''), [autoScroll,setAutoScroll] = useState(true);
  const [copyOperation,setCopyOperation] = useState<Operation>(null);
  const logsRef = useRef<HTMLPreElement>(null);
  const generation = useRef(0);
  const read = async (force: boolean) => {
    const token = generation.current;
    setLoading(true); setError(null);
    try { const next = await readContainerLogs(container.id,revision,force); if(token===generation.current)setEntry(next); }
    catch(failure){if(token===generation.current)setError(errorMessage(failure));}
    finally{if(token===generation.current)setLoading(false);}
  };
  useEffect(()=>{
    if(!active)return;
    let disposed=false, timer:ReturnType<typeof setTimeout> | undefined;
    const cycle=async(force=false)=>{await read(force);if(!disposed&&['running','paused','restarting'].includes(container.state))timer=setTimeout(()=>void cycle(true),2000);};
    void cycle();return()=>{disposed=true;generation.current++;if(timer)clearTimeout(timer);};
  },[active,container.id,container.state,revision]);
  const content=entry?.data.content??'';
  const visible=search?content.split('\n').filter(line=>line.toLowerCase().includes(search.toLowerCase())).join('\n'):content;
  useEffect(()=>{if(autoScroll&&logsRef.current)logsRef.current.scrollTop=logsRef.current.scrollHeight;},[visible,autoScroll]);
  const copy=async()=>{try{await navigator.clipboard.writeText(visible);setCopyOperation({tone:'success',message:'표시된 로그를 복사했습니다.'});}catch(failure){setCopyOperation({tone:'danger',message:errorMessage(failure)});}};
  return <><div className="log-controls"><SearchInput value={search} onChange={setSearch} placeholder={t("로그 검색…")} /><label className="checkbox-control"><input type="checkbox" checked={autoScroll} onChange={event=>setAutoScroll(event.target.checked)}/>{t("자동 스크롤")}</label><button className="button small" disabled={loading} onClick={()=>void read(true)} aria-label={t("로그 새로고침")}><Icon name="refresh" size={14}/></button><button className="button small subtle" disabled={!visible} onClick={()=>void copy()}><Icon name="copy" size={14}/>{t("복사")}</button></div>{error&&<div className="notice error" role="alert">{error}</div>}{copyOperation&&<OperationNotice operation={copyOperation} onDismiss={()=>setCopyOperation(null)}/>}<pre className="logs" ref={logsRef} tabIndex={0} aria-label={t("컨테이너 로그")}>{visible||(loading&&!entry?t("로그 조회 중…"):error?t("로그를 조회할 수 없습니다."):search&&content?t("검색과 일치하는 로그가 없습니다."):t("기록된 로그가 없습니다."))}</pre><div className="log-status"><span>{loading&&entry?t("갱신 중…"):entry?.data.truncated?t("최근 로그 · 일부 잘림"):container.state==='running'?t("최근 최대 300줄 · 2초 간격"):t("최근 최대 300줄")}</span><span>{entry?new Date(entry.readAt).toLocaleTimeString(getLocale()):t("미조회")}</span></div></>;
}

function detailStatus(container: Container): string {
  const exit = /^Exited \(([-0-9]+)\)/.exec(container.status);
  if (container.state === 'exited' && exit) return Number(exit[1]) === 0 ? t('정상 종료 (코드 0)') : t('오류 종료 (코드 {code})', { code: exit[1] });
  return t(({ running: '실행 중', paused: '일시정지됨', restarting: '재시작 중', created: '생성됨', exited: '중지됨', dead: '오류 종료' } as Record<string,string>)[container.state] ?? container.state);
}

export default function Containers(props: EngineProps & { openRequest?: ContainerOpenRequest | null }) {
  const query = useBackendQuery<Container[]>('containers_list', undefined, props.engine?.state === 'connected');
  const [search, setSearch] = useState('');
  const [tablePage, setTablePage] = useState(0);
  const [filter, setFilter] = useState<'all' | 'running' | 'stopped'>('all');
  const [grouped, setGrouped] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'details' | 'logs' | 'inspect' | 'files' | 'terminal'>('details');
  const [inspectFocus, setInspectFocus] = useState('전체');
  const metrics = useContainerMetrics();
  const metricsById = useMemo(() => new Map(metrics.data?.samples.map(sample => [sample.id, sample]) ?? []), [metrics.data]);
  const [working, setWorking] = useState(false);
  const [operation, setOperation] = useState<Operation>(null);
  const destructive = useDestructiveAction(() => {});
  const busy = working || destructive.busy || !!props.mutationBlocked;
  useEffect(() => {
    if (!props.openRequest) return;
    setSearch(''); setFilter('all'); setSelectedId(props.openRequest.id); setDetailTab('logs');
    setOperation({ tone: props.openRequest.started ? 'success' : 'danger', message: props.openRequest.message });
  }, [props.openRequest?.sequence]);
  const selected = query.data?.find(container => container.id === selectedId) ?? null;
  useEffect(() => { if(selected && props.active !== false) void readContainerLogs(selected.id,query.revision).catch(() => {}); }, [selectedId,query.revision,props.active]);
  const hasCompose = query.data?.some(container => container.composeProject) ?? false;
  const filtered = useMemo(() => (query.data ?? []).filter(container => {
    const matchesState = filter === 'all' || (filter === 'running' ? container.state === 'running' : ['exited', 'created', 'dead'].includes(container.state));
    const term = search.toLowerCase();
    return matchesState && `${container.name} ${container.id} ${container.image} ${container.composeProject ?? ''}`.toLowerCase().includes(term);
  }), [query.data, search, filter]);
  const currentPage = Math.min(tablePage, Math.max(0, Math.ceil(filtered.length / 50) - 1));
  const visible = useMemo(() => filtered.slice(currentPage * 50, (currentPage + 1) * 50), [filtered, currentPage]);
  useEffect(() => { setTablePage(0); }, [search, filter]);
  const groups = useMemo(() => {
    if (!grouped || !hasCompose) return [['', visible] as const];
    const values = new Map<string, Container[]>();
    for (const container of visible) { const key = container.composeProject ?? ''; values.set(key, [...(values.get(key) ?? []), container]); }
    return [...values.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visible, grouped, hasCompose]);
  const action = async (container: Container, value: ContainerAction) => {
    if (busy) return;
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
    const port = container.publishedPorts?.find(port => port.protocol === 'tcp');
    if (!port) return;
    try { await backend('container_open_port', { id: container.id, privatePort: port.privatePort, publicPort: port.publicPort }); }
    catch (failure) { setOperation({ tone: 'danger', message: errorMessage(failure) }); }
  };
  const rowCallbacks = useRef({ action, openBrowser }); rowCallbacks.current = { action, openBrowser };
  const selectRow = useCallback((container: Container) => { setSelectedId(container.id); setDetailTab('details'); }, []);
  const actOnRow = useCallback((container: Container, value: ContainerAction) => void rowCallbacks.current.action(container, value), []);
  const browseRow = useCallback((container: Container) => void rowCallbacks.current.openBrowser(container), []);
  const refresh = props.reloadEngine;
  return <><PageHeader title={t("Containers")}><RefreshButton busy={query.loading || props.engineLoading || busy} onClick={() => void refresh()} /></PageHeader><OperationNotice operation={operation} onDismiss={() => setOperation(null)} /><OperationNotice operation={destructive.operation} onDismiss={() => destructive.setOperation(null)} /><EngineGate {...props}><ContainerUsage containers={query.data ?? []} /><div className="toolbar"><SearchInput value={search} onChange={setSearch} placeholder={t("이름, 이미지, 프로젝트 검색…")} /><div className="segmented" aria-label={t("컨테이너 상태 필터")}>{(['all', 'running', 'stopped'] as const).map(value => <button key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t({ all: 'All', running: 'Running', stopped: 'Stopped' }[value])}</button>)}</div>{hasCompose && <label className="checkbox-control"><input type="checkbox" checked={grouped} onChange={event => setGrouped(event.target.checked)} />{t("Compose 그룹")}</label>}</div>{query.error && <ErrorNotice message={query.error} onRetry={() => void query.reload()} />}{query.loading && !query.data ? <StatePanel busy title={t("컨테이너 조회 중")} /> : query.data?.length === 0 ? <StatePanel icon="containers" title={t("컨테이너가 없습니다")} description={t("연결된 Docker Engine에 컨테이너가 없습니다.")} /> : query.data && filtered.length === 0 ? <StatePanel icon="search" title={t("검색 결과가 없습니다")} description={t("검색어나 상태 필터를 변경해 보세요.")}><button className="button" onClick={() => { setSearch(''); setFilter('all'); }}>{t("필터 초기화")}</button></StatePanel> : query.data && <><div className="section-heading"><span className="muted" style={{ fontSize: '0.846154rem' }}>{t('{count}개 컨테이너', { count: filtered.length.toLocaleString(getLocale()) })}</span>{query.loading && <span className="muted" style={{ fontSize: '0.846154rem' }}>{t("목록 갱신 중…")}</span>}</div><div className="container-list"><div className="table-wrap"><table className="data-table container-table"><thead><tr><th style={{ width: 180 }}>{t("이름")}</th><th style={{ width: 96 }}>{t("상태")}</th><th style={{ width: 180 }}>{t("Image")}</th><th style={{ width: 130 }}>{t("포트")}</th><th style={{ width: 86 }}>CPU</th><th style={{ width: 112 }}>{t("메모리")}</th><th style={{ width: 84 }} aria-label={t("작업")} /></tr></thead><tbody>{groups.map(([project, containers]) => containers.map((container, index) => <ContainerRows key={container.id} language={props.language} container={container} metric={metricsById.get(container.id)} showGroup={index === 0 && grouped && hasCompose} project={project} groupCount={containers.length} selected={selectedId === container.id} busy={busy || query.loading} onSelect={selectRow} onBrowser={browseRow} onAction={actOnRow} />))}</tbody></table><Pagination page={currentPage} count={filtered.length} onPage={setTablePage} /></div>{selected && <ContainerDialog key={selected.id} title={selected.name} active={props.active !== false} onClose={() => setSelectedId(null)}><div className="detail-tabs"><div className="segmented"><button className={detailTab === 'details' ? 'active' : ''} aria-pressed={detailTab === 'details'} onClick={() => setDetailTab('details')}>{t('Details')}</button><button className={detailTab === 'logs' ? 'active' : ''} aria-pressed={detailTab === 'logs'} onClick={() => setDetailTab('logs')}>{t("Logs")}</button><button className={detailTab === 'inspect' ? 'active' : ''} aria-pressed={detailTab === 'inspect'} onClick={() => { setInspectFocus('전체'); setDetailTab('inspect'); }}>{t("Inspect")}</button><button onClick={() => { setInspectFocus('Mounts'); setDetailTab('inspect'); }}>{t("Mounts")}</button><button className={detailTab === 'terminal' ? 'active' : ''} aria-pressed={detailTab === 'terminal'} onClick={() => setDetailTab('terminal')}>{t("Terminal")}</button><button className={detailTab === 'files' ? 'active' : ''} aria-pressed={detailTab === 'files'} onClick={() => setDetailTab('files')}>{t("Files")}</button></div></div><div className="detail-pane" hidden={detailTab !== 'inspect'}><ContainerInspect key={selected.id} container={selected} revision={query.revision} active={detailTab === 'inspect' && props.active !== false} focusSection={inspectFocus} /></div><div className="detail-pane" hidden={detailTab !== 'files'}><ContainerFiles key={selected.id} container={selected} revision={query.revision} active={detailTab === 'files' && props.active !== false} /></div><div className="detail-pane" hidden={detailTab !== 'terminal'}><ContainerTerminal key={selected.id} container={selected} active={detailTab === 'terminal' && props.active !== false} /></div><div className="detail-pane log-pane" hidden={detailTab !== 'logs'}><Logs key={selected.id} container={selected} revision={query.revision} active={detailTab === 'logs' && props.active !== false}/></div><div className="detail-pane detail-content" hidden={detailTab !== 'details'}><dl className="detail-meta"><dt>{t("상태")}</dt><dd title={selected.status}>{detailStatus(selected)}</dd><dt>ID</dt><dd className="mono">{selected.id}</dd><dt>{t("이미지")}</dt><dd>{selected.image}</dd><dt>{t("포트")}</dt><dd className="mono">{selected.ports || t("없음")}</dd>{selected.composeProject && <><dt>Compose</dt><dd>{selected.composeProject}</dd></>}</dl><ContainerStats container={selected} active={detailTab === 'details' && props.active !== false} embedded /><div className="detail-actions">{['exited', 'created'].includes(selected.state) && <button className="button" disabled={busy || query.loading} onClick={() => void action(selected, 'start')}><Icon name="play" size={15} />{t("시작")}</button>}{selected.state === 'running' && <><button className="button" disabled={busy || query.loading} onClick={() => void action(selected, 'stop')}><Icon name="stop" size={15} />{t("중지")}</button><button className="button" disabled={busy || query.loading} onClick={() => void action(selected, 'restart')}><Icon name="refresh" size={15} />{t("재시작")}</button></>}<button className="button danger-button" disabled={busy || query.loading || ['running', 'paused'].includes(selected.state)} title={['running', 'paused'].includes(selected.state) ? t("컨테이너를 중지한 뒤 삭제할 수 있습니다") : t("컨테이너 삭제 확인")} onClick={() => void action(selected, 'delete')}><Icon name="trash" size={15} />{t("삭제…")}</button></div></div></ContainerDialog>}</div></>}</EngineGate>{destructive.dialog}</>;
}

const ContainerRows = memo(function ContainerRows({ container, metric, showGroup, project, groupCount, selected, busy, onSelect, onAction, onBrowser }: { language?: 'ko' | 'en'; container: Container; metric?: ContainerMetric; showGroup: boolean; project: string; groupCount: number; selected: boolean; busy: boolean; onSelect: (container: Container) => void; onAction: (container: Container, action: ContainerAction) => void; onBrowser: (container: Container) => void }) {
  const running = container.state === 'running';
  const stopped = ['exited', 'created'].includes(container.state);
  const active = ['running', 'paused', 'restarting'].includes(container.state);
  return <>{showGroup && <tr className="group-row"><td colSpan={7}><span className="group-row-label"><Icon name="containers" size={13} />{project ? `Compose · ${project}` : t("단독 컨테이너")}<span className="group-count">{groupCount}</span></span></td></tr>}<tr className={selected ? 'selected' : ''}><td><button className="name-button" title={container.name} onClick={() => onSelect(container)}>{container.name}</button><span className="cell-subtext" title={container.id}>{container.id.slice(0, 12)}</span></td><td title={container.status}><StatusBadge tone={running ? 'success' : stopped ? 'muted' : 'warning'}>{running ? t("Running") : stopped ? t("Stopped") : container.state}</StatusBadge></td><td title={container.image}>{container.image}</td><td className="mono" title={container.ports}>{container.publishedPorts?.some(port => port.protocol === 'tcp') ? <button className="inline-link" disabled={!running || busy} onClick={() => onBrowser(container)}>{container.ports}</button> : container.ports || t("없음")}</td><td title={metric?.cpuReason ?? undefined}>{metricText(metric, active).cpu}</td><td title={metric?.memoryReason ?? undefined}>{metricText(metric, active).memory}<span className="cell-subtext">{metricText(metric, active).memoryPercent}</span></td><td className="cell-actions"><button className="icon-button" disabled={busy || (!running && !stopped && container.state !== 'paused')} title={running ? t("중지") : container.state === 'paused' ? t("다시 진행") : t("시작")} aria-label={`${container.name} ${running ? '중지' : container.state === 'paused' ? '다시 진행' : '시작'}`} onClick={() => onAction(container, running ? 'stop' : container.state === 'paused' ? 'unpause' : 'start')}><Icon name={running ? 'stop' : 'play'} size={16} /></button><ContainerMenu container={container} busy={busy} onAction={action => onAction(container, action)} onBrowser={() => onBrowser(container)} /></td></tr></>;
});
