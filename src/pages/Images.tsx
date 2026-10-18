import { Fragment, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import ImagePullDialog, { type PullProgress } from '../ImagePullDialog';
import { EngineGate, type EngineProps } from '../App';
import { useImageBuild } from '../ImageBuild';
import { ImageRun, type RunResult } from '../ImageRun';
import ImageRemovalDialog from '../ImageRemovalDialog';
import { backend, refreshDashboardAfterMutation, type ActionResult, type DockerImage, useBackendQuery } from '../api';
import { OperationNotice, type Operation } from '../actions';
import { ErrorNotice, Icon, PageHeader, RefreshButton, SearchInput, StatePanel, StatusBadge, errorMessage, formatBytes, formatDate } from '../components';
import { t } from "../i18n";


interface RegistryImage {
  name: string;
  description: string;
  starCount: number;
  isOfficial: boolean;
}

function RegistrySearch({ busy, connected, openSettings, onSelect }: {
  busy: boolean;
  connected: boolean;
  openSettings?: () => void;
  onSelect: (name: string) => void;
}) {
  const [term, setTerm] = useState('');
  const [searchedTerm, setSearchedTerm] = useState('');
  const [results, setResults] = useState<RegistryImage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
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
  return <section className="panel registry-search-panel" style={{ marginBottom: 16 }} aria-label={t("Docker Hub 이미지 검색")}>
    <div className="section-heading"><h2 style={{ marginBottom: 0 }}>{t("Docker Hub 이미지 검색")}</h2><button className="button small subtle" type="button" aria-expanded={!collapsed} aria-controls="registry-search-body" onClick={() => setCollapsed(value => !value)}>{collapsed ? t("펼치기") : t("접기")}</button></div>
    {!connected && <p className="usage-note" style={{ marginBottom: 12 }}>{t("Docker Hub 검색은 DockSlate 엔진을 통해 실행합니다. Settings에서 런타임을 시작해 주세요.") + " "}{openSettings && <button type="button" className="inline-link" onClick={openSettings}>{t("엔진 설정")}</button>}</p>}
    {collapsed && results && <p className="usage-note">{searchedTerm}{" " + t("· 검색 결과") + " "}{results.length}{t("개")}</p>}
    <div id="registry-search-body" hidden={collapsed}>
    <form className="toolbar" style={{ alignItems: 'flex-end' }} onSubmit={event => { event.preventDefault(); void searchRegistry(); }}>
      <div className="field"><label htmlFor="registry-search">{t("Docker Hub 검색어")}</label><input id="registry-search" className="text-input" value={term} maxLength={128} disabled={busy || searching} onChange={event => setTerm(event.target.value)} placeholder={t("예: nginx, postgres, hashicorp/consul")} spellCheck={false} /></div>
      <button className="button" type="submit" disabled={!term.trim() || busy || searching}><Icon name="search" size={16} />{searching ? t("Docker Hub 검색 중…") : t("Docker Hub 검색")}</button>
    </form>
    {searching && <p className="loading-line" role="status">{t("Docker Hub에서 “")}{searchedTerm}{t("” 검색 결과를 조회합니다.")}</p>}
    {failure && <ErrorNotice message={failure} onRetry={() => void searchRegistry()} />}
    {results && <>
      <div className="section-heading"><span className="muted">“{searchedTerm}{t("” · 최대 25개 중") + " "}{results.length}{t("개 결과")}</span></div>
      {results.length === 0 ? <StatePanel icon="search" title={t("Docker Hub 검색 결과가 없습니다")} description={t("이미지 이름이나 네임스페이스를 확인하고 다시 검색하세요.")} /> : <div className="table-wrap" style={{ maxHeight: 320, marginBottom: 14 }}><table className="data-table" style={{ minWidth: 540 }} aria-label={t("Docker Hub 검색 결과")}><thead><tr><th>{t("이미지 / 설명")}</th><th style={{ width: 100 }}>{t("Stars")}</th><th style={{ width: 140 }}>{t("이미지 선택")}</th></tr></thead><tbody>{results.map(image => <tr key={image.name}><td><strong>{image.name}</strong>{image.isOfficial && <span style={{ marginLeft: 8 }}><StatusBadge tone="accent">{t("Official")}</StatusBadge></span>}<span className="cell-subtext" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: 620 }}>{image.description || t("설명 없음")}</span></td><td>{image.starCount.toLocaleString()}</td><td><button type="button" className="button small" disabled={busy} aria-label={t("{p1} 이미지 선택", { p1: image.name })} onClick={() => onSelect(`${image.name}:latest`)}>{t("선택")}</button></td></tr>)}</tbody></table></div>}
    </>}
    </div>
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
  return <section className="panel" style={{ marginBottom: 16 }} aria-label={t("이미지 Pull")}>
    <div className="section-heading"><h2 style={{ marginBottom: 0 }}>{t("이미지 Pull")}</h2><button type="button" className="icon-button" disabled={busy} onClick={onClose} title={t("Pull 입력 닫기")} aria-label={t("Pull 입력 닫기")}><Icon name="close" /></button></div>
    <form className="toolbar pull-form" style={{ alignItems: 'flex-end', marginBottom: 0 }} onSubmit={event => { event.preventDefault(); onPull(); }}>
      <div className="field"><label htmlFor="image-reference">{t("Pull할 이미지 참조 · 태그 수정 또는 직접 입력")}</label><input ref={referenceInput} id="image-reference" className="text-input mono" value={reference} maxLength={256} disabled={busy} onChange={event => onReference(event.target.value)} placeholder={t("예: nginx:1.28 또는 ghcr.io/owner/image:tag")} spellCheck={false} /></div>
      <button type="submit" className="button primary" disabled={!reference.trim() || busy}>{pulling ? t("Pull 진행 중…") : t("Pull 실행")}</button>
    </form>

  </section>;
}

export default function Images(props: EngineProps & { build: Pick<ReturnType<typeof useImageBuild>, 'busy' | 'picking'>; openBuilds: () => void; onRunBusy?: (busy: boolean) => void; onContainerCreated?: (result: RunResult) => void }) {
  const query = useBackendQuery<DockerImage[]>('images_list', undefined, props.engine?.state === 'connected');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showPull, setShowPull] = useState(false);
  const build = props.build;
  const [reference, setReference] = useState('');
  const referenceInput = useRef<HTMLInputElement>(null);
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);
  const pullFlight = useRef(false);
  const [operation, setOperation] = useState<Operation>(null);
  const [tab, setTab] = useState<'local' | 'registry'>('local');
  const [runImage, setRunImage] = useState<DockerImage | null>(null);
  const [runningContainer, setRunningContainer] = useState(false);
  const [removalImages, setRemovalImages] = useState<DockerImage[] | null>(null);
  const [removalBusy, setRemovalBusy] = useState(false);
  const busy = pulling || removalImages !== null || build.busy || runningContainer || !!props.mutationBlocked;
  useEffect(() => { props.onRunBusy?.(runningContainer || removalBusy || pulling); }, [runningContainer, removalBusy, pulling, props.onRunBusy]);
  useEffect(() => { if (showPull) referenceInput.current?.focus(); }, [showPull]);
  const filtered = useMemo(() => (query.data ?? []).filter(image => `${image.id} ${image.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase())), [query.data, search]);
  const selectable = filtered;
  const selection = (query.data ?? []).filter(image => selected.has(image.id));
  const toggle = (id: string) => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const pull = async () => {
    if (!reference.trim() || busy || pullFlight.current) return;
    pullFlight.current = true;
    const requested = reference.trim(), requestId = crypto.randomUUID();
    setPulling(true); setOperation(null);
    setPullProgress({requestId, reference: requested, phase: 'connecting', status: '', layers: [], receivedBytes: 0, totalBytes: null});
    let unlisten: (() => void) | undefined, finished = false;
    try {
      unlisten = await listen<PullProgress>('image-pull-progress', event => {
        if (!finished && event.payload.requestId === requestId) setPullProgress(event.payload);
      });
      await backend<ActionResult>('image_pull', { reference: requested, requestId });
      finished = true;
      setPullProgress(previous => previous && {...previous, phase: 'completed', error: undefined});
      setReference(''); setShowPull(false);
    } catch (failure) {
      finished = true;
      setPullProgress(previous => previous && {...previous, phase: 'failed', error: errorMessage(failure)});
    } finally {
      unlisten?.(); setPulling(false); pullFlight.current = false;
      void refreshDashboardAfterMutation();
    }
  };
  const remove = (ids: string[]) => {
    if (busy) return;
    const targets = (query.data ?? []).filter(image => ids.includes(image.id));
    if (!targets.length) return;
    setOperation(null); setRemovalImages(targets);
  };
  const refresh = props.reloadEngine;
  return <><PageHeader title={t("Images")}><RefreshButton busy={query.loading || props.engineLoading || busy} onClick={() => void refresh()} /><button className="button primary" disabled={props.engine?.state !== 'connected' || busy || query.loading} onClick={() => { setTab('local'); setShowPull(value => !value); }} aria-expanded={showPull}><Icon name="download" size={16} />{t("Pull image")}</button><button className="button primary" disabled={busy || build.picking} onClick={props.openBuilds}><Icon name="images" size={16} />{t("이미지 빌드")}</button></PageHeader><OperationNotice operation={operation} onDismiss={() => setOperation(null)} /><div className="page-tabs" role="tablist" aria-label={t('이미지 보기')}><button role="tab" aria-selected={tab === 'local'} className={tab === 'local' ? 'active' : ''} onClick={() => setTab('local')}>{t('로컬 이미지')}</button><button role="tab" aria-selected={tab === 'registry'} className={tab === 'registry' ? 'active' : ''} onClick={() => setTab('registry')}>Docker Hub</button></div><div hidden={tab !== 'registry'}><RegistrySearch connected={props.engine?.state === 'connected'} openSettings={props.openRuntimeSettings} busy={busy || query.loading || props.engine?.state !== 'connected'} onSelect={value => { setReference(value); setShowPull(true); setTab('local'); referenceInput.current?.focus(); }} /></div><div hidden={tab !== 'local'}><EngineGate {...props}>{showPull && <PullForm reference={reference} onReference={setReference} busy={busy || query.loading} pulling={pulling} onPull={() => void pull()} onClose={() => setShowPull(false)} referenceInput={referenceInput} />}<div className="section-heading"><div><h2>{t("로컬 이미지")}</h2></div><button className="button small" disabled={busy || build.picking} onClick={props.openBuilds}>{t("Dockerfile로 이미지 빌드")}</button></div><div className="toolbar"><SearchInput value={search} onChange={setSearch} placeholder={t("로컬 이미지 이름, 태그, ID 검색…")} /><button className="button danger-button" disabled={selection.length === 0 || busy || query.loading} onClick={() => void remove(selection.map(image => image.id))}><Icon name="trash" size={15} />{t("선택 삭제")}{selection.length > 0 ? ` (${selection.length})` : ''}</button></div>{query.error && <ErrorNotice message={query.error} onRetry={() => void query.reload()} />}{query.loading && !query.data ? <StatePanel busy title={t("이미지 조회 중")} /> : query.data?.length === 0 ? <StatePanel icon="images" title={t("이미지가 없습니다")} description={t("연결된 Docker Engine에 로컬 이미지가 없습니다. Pull image에서 이미지 참조를 입력하세요.")} /> : query.data && filtered.length === 0 ? <StatePanel icon="search" title={t("검색 결과가 없습니다")} description={t("이미지 이름, 태그 또는 ID를 확인해 보세요.")}><button className="button" onClick={() => setSearch('')}>{t("검색 초기화")}</button></StatePanel> : query.data && <><div className="section-heading"><span className="muted" style={{ fontSize: '0.846154rem' }}>{filtered.length.toLocaleString()}{t("개 이미지 · 참조 컨테이너와 실제 상태를 검사한 뒤 삭제를 승인합니다.")}</span>{query.loading && <span className="muted" style={{ fontSize: '0.846154rem' }}>{t("목록 갱신 중…")}</span>}</div><div className="table-wrap"><table className="data-table" style={{ minWidth: 620 }}><thead><tr><th style={{ width: 44 }}><input type="checkbox" disabled={busy || query.loading || selectable.length === 0} checked={selectable.length > 0 && selectable.every(image => selected.has(image.id))} aria-label={t("검색 결과의 이미지 모두 선택")} onChange={event => setSelected(previous => { const next = new Set(previous); for (const image of selectable) { if (event.target.checked) next.add(image.id); else next.delete(image.id); } return next; })} /></th><th>{t("Repository / Tag")}</th><th style={{ width: 100 }}>{t("Size")}</th><th style={{ width: 135 }}>{t("사용 상태")}</th><th style={{ width: 145 }}>{t("Created")}</th><th style={{ width: 144 }} aria-label={t("이미지 작업")} /></tr></thead><tbody>{filtered.map(image => <Fragment key={image.id}><tr className={selected.has(image.id) ? 'selected' : ''}><td><input type="checkbox" disabled={busy || query.loading} checked={selected.has(image.id)} onChange={() => toggle(image.id)} aria-label={t("{p1} 선택", { p1: image.tags[0] ?? image.id })} title={image.containers !== 0 ? t("참조 컨테이너를 검사할 삭제 대상 선택") : t("삭제 대상 선택")} /></td><td title={image.tags.length ? image.tags.join('\n') : image.id}><span>{image.tags[0] ?? '<untagged>'}{image.tags.length > 1 && <span className="muted">{" " + t("외") + " "}{image.tags.length - 1}{t("개")}</span>}</span><span className="cell-subtext" title={image.id}>{image.id.replace(/^sha256:/, '').slice(0, 12)}</span></td><td>{formatBytes(image.size)}</td><td><StatusBadge tone={image.containers === 0 ? 'muted' : image.containers > 0 ? 'accent' : 'warning'}>{image.containers === 0 ? t("미사용") : image.containers > 0 ? t("{p1}개에서 참조", { p1: image.containers }) : t("사용 상태 미확인")}</StatusBadge></td><td title={formatDate(image.created)} className="muted">{new Date(image.created * 1000).toLocaleDateString()}</td><td className="cell-actions"><button className="button small" disabled={busy || query.loading} onClick={() => setRunImage(current => current?.id === image.id ? null : image)} aria-expanded={runImage?.id === image.id} aria-controls={"run-image-" + image.id.replace(/^sha256:/, "")} aria-label={t("{p1} 컨테이너 실행", { p1: image.tags[0] ?? image.id })}><Icon name="play" size={14} />{t("실행")}</button><button className="icon-button danger" disabled={busy || query.loading} onClick={() => remove([image.id])} title={image.containers !== 0 ? t("참조 컨테이너와 삭제 가능 상태 확인") : t("이미지 삭제 확인")} aria-label={t("{p1} 삭제", { p1: image.tags[0] ?? image.id })}><Icon name="trash" size={16} /></button></td></tr>{runImage?.id === image.id && <tr className="image-run-row"><td colSpan={6} id={"run-image-" + image.id.replace(/^sha256:/, "")}><ImageRun image={runImage} blocked={pulling || removalImages !== null || build.busy || props.engine?.state !== 'connected'} onClose={() => setRunImage(null)} onBusy={setRunningContainer} onCreated={result => { setRunImage(null); props.onContainerCreated?.(result); }} /></td></tr>}</Fragment>)}</tbody></table></div></>}</EngineGate></div>{removalImages && <ImageRemovalDialog images={removalImages} onBusy={setRemovalBusy} onClose={() => setRemovalImages(null)} onComplete={result => { setSelected(previous => new Set([...previous].filter(id => !result.deleted.includes(id)))); setOperation({ tone: result.failed.length ? 'danger' : 'success', message: result.message + (result.failed.length ? ' · ' + result.failed.map(failure => failure.id + ': ' + failure.error).join(' / ') : '') }); }} />}{pullProgress && <ImagePullDialog progress={pullProgress} active={props.active !== false} onClose={() => setPullProgress(null)} />}</>;
}
