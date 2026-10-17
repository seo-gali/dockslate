import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EngineGate, type EngineProps } from '../App';
import { backend, refreshDashboardAfterMutation, type ActionResult, type Container, type ContainerLogs, useBackendQuery } from '../api';
import { OperationNotice, useDestructiveAction, type Operation } from '../actions';
import { DetailPanel, ErrorNotice, Icon, PageHeader, RefreshButton, SearchInput, StatePanel, StatusBadge, errorMessage } from '../components';

type ContainerAction = 'start' | 'stop' | 'restart' | 'delete';

function ContainerMenu({ container, busy, onAction, onLogs }: { container: Container; busy: boolean; onAction: (action: ContainerAction) => void; onLogs: () => void }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!position) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) setPosition(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setPosition(null); buttonRef.current?.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        event.preventDefault(); items[next]?.focus();
      }
      if (event.key === 'Tab') setPosition(null);
    };
    const close = () => setPosition(null);
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); window.removeEventListener('resize', close); };
  }, [position]);
  const isRunning = container.state === 'running';
  const canStart = container.state === 'exited' || container.state === 'created';
  const action = (value: ContainerAction) => { setPosition(null); onAction(value); };
  return <span className="row-menu"><button ref={buttonRef} className="icon-button" title={`${container.name} 작업`} aria-label={`${container.name} 작업`} aria-haspopup="menu" aria-expanded={position !== null} disabled={busy} onClick={() => {
    if (position) { setPosition(null); return; }
    const rect = buttonRef.current!.getBoundingClientRect();
    setPosition({ top: Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - 212)), left: Math.max(8, rect.right - 168) });
  }}><Icon name="more" /></button>{position && createPortal(<div ref={menuRef} className="action-menu" role="menu" style={position}><button role="menuitem" disabled={!canStart} onClick={() => action('start')}><Icon name="play" size={15} />시작</button><button role="menuitem" disabled={!isRunning} onClick={() => action('stop')}><Icon name="stop" size={15} />중지</button><button role="menuitem" disabled={!isRunning} onClick={() => action('restart')}><Icon name="refresh" size={15} />재시작</button><button role="menuitem" onClick={() => { setPosition(null); onLogs(); }}><Icon name="containers" size={15} />로그 보기</button><div className="menu-divider" /><button role="menuitem" className="danger" disabled={isRunning || container.state === 'paused'} onClick={() => action('delete')} title={isRunning || container.state === 'paused' ? '컨테이너를 중지한 뒤 삭제할 수 있습니다' : undefined}><Icon name="trash" size={15} />삭제…</button></div>, document.body)}</span>;
}

function Logs({ container }: { container: Container }) {
  const query = useBackendQuery<ContainerLogs>('container_logs', { id: container.id });
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copyOperation, setCopyOperation] = useState<Operation>(null);
  const logsRef = useRef<HTMLPreElement>(null);
  const [lastRead, setLastRead] = useState<string | null>(null);
  useEffect(() => {
    if (query.loading) return;
    const timer = window.setTimeout(() => void query.reload(), 2000);
    return () => window.clearTimeout(timer);
  }, [query.loading, query.reload]);
  useEffect(() => { if (query.data) setLastRead(new Date().toLocaleTimeString()); }, [query.data]);
  const content = query.data?.content ?? '';
  const visible = search ? content.split('\n').filter(line => line.toLowerCase().includes(search.toLowerCase())).join('\n') : content;
  useEffect(() => { if (autoScroll && logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight; }, [visible, autoScroll]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(visible); setCopyOperation({ tone: 'success', message: '표시된 로그를 복사했습니다.' }); }
    catch (failure) { setCopyOperation({ tone: 'danger', message: `로그 복사 실패: ${errorMessage(failure)}` }); }
  };
  return <><div className="log-controls"><SearchInput value={search} onChange={setSearch} placeholder="로그 검색…" /><label className="checkbox-control"><input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} />자동 스크롤</label><button className="button small subtle" disabled={!visible} onClick={() => void copy()}><Icon name="copy" size={14} />복사</button></div>{query.error && <div className="detail-content"><ErrorNotice message={query.error} onRetry={() => void query.reload()} /></div>}{copyOperation && <div className="detail-content" style={{ paddingBottom: 0 }}><OperationNotice operation={copyOperation} onDismiss={() => setCopyOperation(null)} /></div>}<pre className="logs" ref={logsRef} tabIndex={0} aria-label="컨테이너 로그">{visible || (query.loading && !query.data ? '로그 조회 중…' : query.error ? '로그를 조회할 수 없습니다.' : search && content ? '검색과 일치하는 로그가 없습니다.' : '기록된 로그가 없습니다.')}</pre><div className="log-status"><span>{query.data?.truncated ? '최근 로그 · 일부 잘림' : '최근 최대 300줄'} · 2초 간격 갱신</span><span>{lastRead ? `${lastRead} 조회` : '미조회'}</span></div></>;
}

export default function Containers(props: EngineProps) {
  const query = useBackendQuery<Container[]>('containers_list', undefined, props.engine?.state === 'connected');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'running' | 'stopped'>('all');
  const [grouped, setGrouped] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'details' | 'logs'>('details');
  const [working, setWorking] = useState(false);
  const [operation, setOperation] = useState<Operation>(null);
  const destructive = useDestructiveAction(() => {});
  const busy = working || destructive.busy || !!props.mutationBlocked;
  const selected = query.data?.find(container => container.id === selectedId) ?? null;
  const hasCompose = query.data?.some(container => container.composeProject) ?? false;
  const filtered = useMemo(() => (query.data ?? []).filter(container => {
    const matchesState = filter === 'all' || (filter === 'running' ? container.state === 'running' : ['exited', 'created', 'dead'].includes(container.state));
    const term = search.toLowerCase();
    return matchesState && `${container.name} ${container.id} ${container.image} ${container.composeProject ?? ''}`.toLowerCase().includes(term);
  }), [query.data, search, filter]);
  const groups = useMemo(() => {
    if (!grouped || !hasCompose) return [['', filtered] as const];
    const values = new Map<string, Container[]>();
    for (const container of filtered) { const key = container.composeProject ?? ''; values.set(key, [...(values.get(key) ?? []), container]); }
    return [...values.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered, grouped, hasCompose]);
  const action = async (container: Container, value: ContainerAction) => {
    if (busy) return;
    if (value === 'delete') { setOperation(null); await destructive.prepare({ kind: 'container_delete', ids: [container.id] }, [`${container.name} · ${container.id}`]); return; }
    setWorking(true);
    destructive.setOperation(null);
    const actionName = { start: '시작', stop: '중지', restart: '재시작' }[value];
    setOperation({ tone: 'accent', message: `${container.name} ${actionName} 처리 중…` });
    try {
      const result = await backend<ActionResult>('container_action', { id: container.id, action: value });
      setOperation({ tone: 'success', message: result.message });
    } catch (failure) { setOperation({ tone: 'danger', message: `${actionName} 실패: ${errorMessage(failure)}` }); }
    finally { await refreshDashboardAfterMutation(); setWorking(false); }
  };
  const refresh = props.reloadEngine;
  return <><PageHeader title="Containers" description="컨테이너 상태를 확인하고 작업과 로그를 관리합니다."><RefreshButton busy={query.loading || props.engineLoading || busy} onClick={() => void refresh()} /></PageHeader><OperationNotice operation={operation} onDismiss={() => setOperation(null)} /><OperationNotice operation={destructive.operation} onDismiss={() => destructive.setOperation(null)} /><EngineGate {...props}><div className="toolbar"><SearchInput value={search} onChange={setSearch} placeholder="이름, 이미지, 프로젝트 검색…" /><div className="segmented" aria-label="컨테이너 상태 필터">{(['all', 'running', 'stopped'] as const).map(value => <button key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{{ all: 'All', running: 'Running', stopped: 'Stopped' }[value]}</button>)}</div>{hasCompose && <label className="checkbox-control"><input type="checkbox" checked={grouped} onChange={event => setGrouped(event.target.checked)} />Compose 그룹</label>}</div>{query.error && <ErrorNotice message={query.error} onRetry={() => void query.reload()} />}{query.loading && !query.data ? <StatePanel busy title="컨테이너 조회 중" /> : query.data?.length === 0 ? <StatePanel icon="containers" title="컨테이너가 없습니다" description="연결된 Docker Engine에 컨테이너가 없습니다." /> : query.data && filtered.length === 0 ? <StatePanel icon="search" title="검색 결과가 없습니다" description="검색어나 상태 필터를 변경해 보세요."><button className="button" onClick={() => { setSearch(''); setFilter('all'); }}>필터 초기화</button></StatePanel> : query.data && <><div className="section-heading"><span className="muted" style={{ fontSize: 11 }}>{filtered.length.toLocaleString()}개 컨테이너</span>{query.loading && <span className="muted" style={{ fontSize: 11 }}>목록 갱신 중…</span>}</div><div className={`split-view ${selected ? 'with-detail' : ''}`}><div className="table-wrap"><table className="data-table container-table"><thead><tr><th style={{ width: '27%' }}>Name</th><th style={{ width: 96 }}>Status</th><th style={{ width: '26%' }}>Image</th><th>Ports</th><th style={{ width: 48 }} aria-label="작업" /></tr></thead><tbody>{groups.map(([project, containers]) => containers.map((container, index) => <ContainerRows key={container.id} container={container} showGroup={index === 0 && grouped && hasCompose} project={project} groupCount={containers.length} selected={selectedId === container.id} busy={busy || query.loading} onSelect={() => { setSelectedId(container.id); setDetailTab('details'); }} onLogs={() => { setSelectedId(container.id); setDetailTab('logs'); }} onAction={value => void action(container, value)} />))}</tbody></table></div>{selected && <DetailPanel title={selected.name} onClose={() => setSelectedId(null)}><div className="detail-tabs"><div className="segmented"><button className={detailTab === 'details' ? 'active' : ''} aria-pressed={detailTab === 'details'} onClick={() => setDetailTab('details')}>Details</button><button className={detailTab === 'logs' ? 'active' : ''} aria-pressed={detailTab === 'logs'} onClick={() => setDetailTab('logs')}>Logs</button></div></div>{detailTab === 'logs' && props.active !== false ? <Logs key={selected.id} container={selected} /> : <div className="detail-content"><dl className="detail-meta"><dt>상태</dt><dd>{selected.status}</dd><dt>ID</dt><dd className="mono">{selected.id}</dd><dt>이미지</dt><dd>{selected.image}</dd><dt>포트</dt><dd className="mono">{selected.ports || '없음'}</dd>{selected.composeProject && <><dt>Compose</dt><dd>{selected.composeProject}</dd></>}</dl><div className="detail-actions">{['exited', 'created'].includes(selected.state) && <button className="button" disabled={busy || query.loading} onClick={() => void action(selected, 'start')}><Icon name="play" size={15} />시작</button>}{selected.state === 'running' && <><button className="button" disabled={busy || query.loading} onClick={() => void action(selected, 'stop')}><Icon name="stop" size={15} />중지</button><button className="button" disabled={busy || query.loading} onClick={() => void action(selected, 'restart')}><Icon name="refresh" size={15} />재시작</button></>}<button className="button danger-button" disabled={busy || query.loading || ['running', 'paused'].includes(selected.state)} title={['running', 'paused'].includes(selected.state) ? '컨테이너를 중지한 뒤 삭제할 수 있습니다' : '컨테이너 삭제 확인'} onClick={() => void action(selected, 'delete')}><Icon name="trash" size={15} />삭제…</button></div></div>}</DetailPanel>}</div></>}</EngineGate>{destructive.dialog}</>;
}

function ContainerRows({ container, showGroup, project, groupCount, selected, busy, onSelect, onLogs, onAction }: { container: Container; showGroup: boolean; project: string; groupCount: number; selected: boolean; busy: boolean; onSelect: () => void; onLogs: () => void; onAction: (action: ContainerAction) => void }) {
  const running = container.state === 'running';
  const stopped = ['exited', 'created', 'dead'].includes(container.state);
  return <>{showGroup && <tr className="group-row"><td colSpan={5}><span className="group-row-label"><Icon name="containers" size={13} />{project ? `Compose · ${project}` : '단독 컨테이너'}<span className="group-count">{groupCount}개</span></span></td></tr>}<tr className={selected ? 'selected' : ''}><td><button className="name-button" title={container.name} onClick={onSelect}>{container.name}</button><span className="cell-subtext" title={container.id}>{container.id.slice(0, 12)}</span></td><td title={container.status}><StatusBadge tone={running ? 'success' : stopped ? 'muted' : 'warning'}>{running ? 'Running' : stopped ? 'Stopped' : container.state}</StatusBadge></td><td title={container.image}>{container.image}</td><td className="mono" title={container.ports}>{container.ports || '없음'}</td><td className="cell-actions"><ContainerMenu container={container} busy={busy} onAction={onAction} onLogs={onLogs} /></td></tr></>;
}
