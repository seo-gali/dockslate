import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { EngineGate, type EngineProps } from '../App';
import { ImageBuildPanel, useImageBuild } from '../ImageBuild';
import { backend, refreshDashboardAfterMutation, type ActionResult, type DockerImage, useBackendQuery } from '../api';
import { OperationNotice, useDestructiveAction, type Operation } from '../actions';
import { ErrorNotice, Icon, PageHeader, RefreshButton, SearchInput, StatePanel, StatusBadge, errorMessage, formatBytes, formatDate } from '../components';

interface RegistryImage {
  name: string;
  description: string;
  starCount: number;
  isOfficial: boolean;
}

function RegistrySearch({ busy, onSelect }: {
  busy: boolean;
  onSelect: (name: string) => void;
}) {
  const [term, setTerm] = useState('');
  const [searchedTerm, setSearchedTerm] = useState('');
  const [results, setResults] = useState<RegistryImage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const searchRegistry = async () => {
    if (!term.trim() || busy || inFlight.current) return;
    inFlight.current = true;
    setSearching(true);
    setFailure(null);
    setResults(null);
    const requestedTerm = term.trim();
    setSearchedTerm(requestedTerm);
    try {
      setResults(await backend<RegistryImage[]>('image_search', { term: requestedTerm }));
    } catch (error) { setFailure(`Docker Hub 검색 실패: ${errorMessage(error)}`); }
    finally { setSearching(false); inFlight.current = false; }
  };
  return <section className="panel registry-search-panel" style={{ marginBottom: 16 }} aria-label="Docker Hub 이미지 검색">
    <div className="section-heading"><h2 style={{ marginBottom: 0 }}>Docker Hub 이미지 검색</h2><span className="muted">검색 후 이미지를 선택해 Pull합니다.</span></div>
    <form className="toolbar" style={{ alignItems: 'flex-end' }} onSubmit={event => { event.preventDefault(); void searchRegistry(); }}>
      <div className="field"><label htmlFor="registry-search">Docker Hub 검색어</label><input id="registry-search" className="text-input" value={term} maxLength={128} disabled={busy || searching} onChange={event => setTerm(event.target.value)} placeholder="예: nginx, postgres, hashicorp/consul" spellCheck={false} /></div>
      <button className="button" type="submit" disabled={!term.trim() || busy || searching}><Icon name="search" size={16} />{searching ? 'Docker Hub 검색 중…' : 'Docker Hub 검색'}</button>
    </form>
    {searching && <p className="loading-line" role="status">Docker Hub에서 “{searchedTerm}” 검색 결과를 조회합니다.</p>}
    {failure && <ErrorNotice message={failure} onRetry={() => void searchRegistry()} />}
    {results && <>
      <div className="section-heading"><span className="muted">“{searchedTerm}” · 최대 25개 중 {results.length}개 결과</span></div>
      {results.length === 0 ? <StatePanel icon="search" title="Docker Hub 검색 결과가 없습니다" description="이미지 이름이나 네임스페이스를 확인하고 다시 검색하세요." /> : <div className="table-wrap" style={{ maxHeight: 320, marginBottom: 14 }}><table className="data-table" style={{ minWidth: 540 }} aria-label="Docker Hub 검색 결과"><thead><tr><th>이미지 / 설명</th><th style={{ width: 100 }}>Stars</th><th style={{ width: 140 }}>이미지 선택</th></tr></thead><tbody>{results.map(image => <tr key={image.name}><td><strong>{image.name}</strong>{image.isOfficial && <span style={{ marginLeft: 8 }}><StatusBadge tone="accent">Official</StatusBadge></span>}<span className="cell-subtext" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: 620 }}>{image.description || '설명 없음'}</span></td><td>{image.starCount.toLocaleString()}</td><td><button type="button" className="button small" disabled={busy} aria-label={`${image.name} 이미지 선택`} onClick={() => onSelect(`${image.name}:latest`)}>선택</button></td></tr>)}</tbody></table></div>}
    </>}
  </section>;
}

function PullForm({ reference, onReference, busy, pulling, onPull, onClose, referenceInput }: {
  reference: string;
  onReference: (value: string) => void;
  busy: boolean;
  pulling: boolean;
  onPull: () => void;
  onClose: () => void;
  referenceInput: RefObject<HTMLInputElement | null>;
}) {
  return <section className="panel" style={{ marginBottom: 16 }} aria-label="이미지 Pull">
    <div className="section-heading"><h2 style={{ marginBottom: 0 }}>이미지 Pull</h2><button type="button" className="icon-button" disabled={busy} onClick={onClose} title="Pull 입력 닫기" aria-label="Pull 입력 닫기"><Icon name="close" /></button></div>
    <form className="toolbar pull-form" style={{ alignItems: 'flex-end', marginBottom: 0 }} onSubmit={event => { event.preventDefault(); onPull(); }}>
      <div className="field"><label htmlFor="image-reference">Pull할 이미지 참조 · 태그 수정 또는 직접 입력</label><input ref={referenceInput} id="image-reference" className="text-input mono" value={reference} maxLength={256} disabled={busy} onChange={event => onReference(event.target.value)} placeholder="예: nginx:1.28 또는 ghcr.io/owner/image:tag" spellCheck={false} /></div>
      <button type="submit" className="button primary" disabled={!reference.trim() || busy}>{pulling ? 'Pull 진행 중…' : 'Pull 실행'}</button>
    </form>
    <p className="usage-note">검색 결과를 선택하면 :latest가 입력됩니다. 원하는 태그로 수정한 뒤 Pull 실행을 누르세요. 태그를 생략해도 :latest를 사용합니다.</p>
  </section>;
}

export default function Images(props: EngineProps & { onBuildBusy?: (busy: boolean) => void }) {
  const query = useBackendQuery<DockerImage[]>('images_list', undefined, props.engine?.state === 'connected');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showPull, setShowPull] = useState(false);
  const [showBuild, setShowBuild] = useState(false);
  const build = useImageBuild(props.onBuildBusy);
  const [reference, setReference] = useState('');
  const referenceInput = useRef<HTMLInputElement>(null);
  const [pulling, setPulling] = useState(false);
  const [operation, setOperation] = useState<Operation>(null);
  const destructive = useDestructiveAction(() => { setSelected(new Set()); });
  const busy = pulling || destructive.busy || build.busy || !!props.mutationBlocked;
  useEffect(() => { if (showPull) referenceInput.current?.focus(); }, [showPull]);
  const filtered = useMemo(() => (query.data ?? []).filter(image => `${image.id} ${image.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase())), [query.data, search]);
  const selectable = filtered.filter(image => image.containers === 0);
  const selection = (query.data ?? []).filter(image => selected.has(image.id) && image.containers === 0);
  const toggle = (id: string) => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const pull = async () => {
    if (!reference.trim() || busy) return;
    setPulling(true);
    destructive.setOperation(null);
    setOperation({ tone: 'accent', message: `${reference.trim()} Pull 진행 중… 완료 응답을 기다립니다.` });
    try {
      const result = await backend<ActionResult>('image_pull', { reference: reference.trim() });
      setOperation({ tone: 'success', message: result.message });
      setReference('');
    } catch (failure) { setOperation({ tone: 'danger', message: `Pull 실패: ${errorMessage(failure)}` }); }
    finally { await refreshDashboardAfterMutation(); setPulling(false); }
  };
  const remove = async (ids: string[]) => { setOperation(null); await destructive.prepare({ kind: 'image_delete', ids }, ids.map(id => `${query.data?.find(image => image.id === id)?.tags[0] ?? '<untagged>'} · ${id}`)); };
  const refresh = props.reloadEngine;
  return <><PageHeader title="Images" description="이미지를 검색하고 Pull·빌드·선택 삭제합니다."><RefreshButton busy={query.loading || props.engineLoading || busy} onClick={() => void refresh()} /><button className="button primary" disabled={props.engine?.state !== 'connected' || busy || query.loading} onClick={() => setShowPull(value => !value)} aria-expanded={showPull}><Icon name="download" size={16} />Pull image</button><button className="button primary" disabled={busy || build.picking} onClick={() => setShowBuild(value => !value)} aria-expanded={showBuild}><Icon name="images" size={16} />이미지 빌드</button></PageHeader><OperationNotice operation={operation} onDismiss={() => setOperation(null)} /><OperationNotice operation={destructive.operation} onDismiss={() => destructive.setOperation(null)} /><>{showBuild && <ImageBuildPanel build={build} connected={props.engine?.state === 'connected'} blocked={pulling || destructive.busy} onClose={() => setShowBuild(false)} />}</><RegistrySearch busy={busy || query.loading || props.engine?.state !== 'connected'} onSelect={value => { setReference(value); setShowPull(true); referenceInput.current?.focus(); }} /><EngineGate {...props}>{showPull && <PullForm reference={reference} onReference={setReference} busy={busy || query.loading} pulling={pulling} onPull={() => void pull()} onClose={() => setShowPull(false)} referenceInput={referenceInput} />}<div className="toolbar"><SearchInput value={search} onChange={setSearch} placeholder="로컬 이미지 이름, 태그, ID 검색…" /><button className="button danger-button" disabled={selection.length === 0 || busy || query.loading} onClick={() => void remove(selection.map(image => image.id))}><Icon name="trash" size={15} />선택 삭제{selection.length > 0 ? ` (${selection.length})` : ''}</button></div>{query.error && <ErrorNotice message={query.error} onRetry={() => void query.reload()} />}{query.loading && !query.data ? <StatePanel busy title="이미지 조회 중" /> : query.data?.length === 0 ? <StatePanel icon="images" title="이미지가 없습니다" description="연결된 Docker Engine에 로컬 이미지가 없습니다. Pull image에서 이미지 참조를 입력하세요." /> : query.data && filtered.length === 0 ? <StatePanel icon="search" title="검색 결과가 없습니다" description="이미지 이름, 태그 또는 ID를 확인해 보세요."><button className="button" onClick={() => setSearch('')}>검색 초기화</button></StatePanel> : query.data && <><div className="section-heading"><span className="muted" style={{ fontSize: 11 }}>{filtered.length.toLocaleString()}개 이미지 · 컨테이너 참조가 없는 이미지만 삭제할 수 있습니다.</span>{query.loading && <span className="muted" style={{ fontSize: 11 }}>목록 갱신 중…</span>}</div><div className="table-wrap"><table className="data-table" style={{ minWidth: 620 }}><thead><tr><th style={{ width: 44 }}><input type="checkbox" disabled={busy || query.loading || selectable.length === 0} checked={selectable.length > 0 && selectable.every(image => selected.has(image.id))} aria-label="검색 결과의 미사용 이미지 모두 선택" onChange={event => setSelected(previous => { const next = new Set(previous); for (const image of selectable) { if (event.target.checked) next.add(image.id); else next.delete(image.id); } return next; })} /></th><th>Repository / Tag</th><th style={{ width: 100 }}>Size</th><th style={{ width: 135 }}>사용 상태</th><th style={{ width: 145 }}>Created</th><th style={{ width: 48 }} aria-label="삭제" /></tr></thead><tbody>{filtered.map(image => <tr key={image.id} className={selected.has(image.id) ? 'selected' : ''}><td><input type="checkbox" disabled={busy || query.loading || image.containers !== 0} checked={selected.has(image.id) && image.containers === 0} onChange={() => toggle(image.id)} aria-label={`${image.tags[0] ?? image.id} 선택`} title={image.containers !== 0 ? '컨테이너가 참조하거나 사용 상태를 확인하지 못한 이미지입니다' : '삭제 대상 선택'} /></td><td title={image.tags.length ? image.tags.join('\n') : image.id}><span>{image.tags[0] ?? '<untagged>'}{image.tags.length > 1 && <span className="muted"> 외 {image.tags.length - 1}개</span>}</span><span className="cell-subtext" title={image.id}>{image.id.replace(/^sha256:/, '').slice(0, 12)}</span></td><td>{formatBytes(image.size)}</td><td><StatusBadge tone={image.containers === 0 ? 'muted' : image.containers > 0 ? 'accent' : 'warning'}>{image.containers === 0 ? '미사용' : image.containers > 0 ? `${image.containers}개에서 참조` : '사용 상태 미확인'}</StatusBadge></td><td title={formatDate(image.created)} className="muted">{new Date(image.created * 1000).toLocaleDateString()}</td><td className="cell-actions"><button className="icon-button danger" disabled={busy || query.loading || image.containers !== 0} onClick={() => void remove([image.id])} title={image.containers !== 0 ? '참조 중이거나 사용 상태가 미확인인 이미지입니다' : '이미지 삭제 확인'} aria-label={`${image.tags[0] ?? image.id} 삭제`}><Icon name="trash" size={16} /></button></td></tr>)}</tbody></table></div><p className="usage-note">삭제 실행 직전에 컨테이너 참조 상태를 다시 확인합니다. 이미지가 참조 중이면 삭제를 차단합니다.</p></>}</EngineGate>{destructive.dialog}</>;
}
