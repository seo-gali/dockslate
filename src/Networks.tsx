import { ResizableTable } from './ResizableColumns';
import { TableFilters, useTableRows } from './TableRows';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EngineGate, type EngineProps } from './App';
import { backend, refreshDashboardAfterMutation, type DestructiveResult, useBackendQuery } from './api';
import { OperationNotice, type Operation } from './actions';
import { ContainerReferences, ConfirmDialog, DetailPanel, ErrorNotice, Icon, PageHeader, Pagination, SearchInput, StatePanel, StatusBadge, errorMessage } from './components';
import { getLocale, t } from "./i18n";


interface NetworkContainer { id: string; name: string; state: string }
interface Network {
  id: string; name: string; driver: string; scope: string; internal: boolean; builtin: boolean;
  ipam: { Driver?: string; Options?: Record<string, string> | null; Config?: { Subnet?: string; Gateway?: string; IPRange?: string; AuxiliaryAddresses?: Record<string, string> }[] | null } | null;
  containers: NetworkContainer[]; deletable: boolean; deleteBlockedReason: string | null;
}
interface NetworkPreview { token: string; expiresAt: number; network: Network }

function blockedReason(network: Network): string | null {
  if (network.builtin) return t("기본 네트워크는 삭제할 수 없습니다.");
  if (network.containers.length) return t("참조 컨테이너가 있습니다. 중지된 컨테이너의 참조도 해제한 뒤 삭제할 수 있습니다.");
  if (!network.deletable) return network.deleteBlockedReason ?? t("네트워크의 삭제 조건을 확인하지 못했습니다.");
  return null;
}

export default function Networks(props: EngineProps & { noPageHeader?: boolean; onBusy?: (busy: boolean) => void }) {
  const query = useBackendQuery<Network[]>('networks_list', undefined, props.engine?.state === 'connected');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [internal, setInternal] = useState(false);
  const [working, setWorking] = useState(false);
  const [operation, setOperation] = useState<Operation>(null);
  const [target, setTarget] = useState<Network | null>(null);
  const [preview, setPreview] = useState<NetworkPreview | null>(null);
  const [validating, setValidating] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const busyCallback = useRef(props.onBusy);
  busyCallback.current = props.onBusy;
  const busy = working || target !== null || !!props.mutationBlocked;
  useEffect(() => { busyCallback.current?.(working || target !== null); }, [working, target]);
  useEffect(() => () => { generation.current += 1; busyCallback.current?.(false); }, []);
  useEffect(() => { setPage(0); }, [search]);
  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (query.data ?? []).filter(network => `${network.name} ${network.id} ${network.driver} ${network.containers.map(container => container.name).join(' ')}`.toLowerCase().includes(term));
  }, [query.data, search]);
  const networkRows = useTableRows(matches, [{ value: network => network.name }, { value: network => network.driver, enum: true }, { value: network => network.builtin ? '기본' : network.containers.length ? '참조 중' : network.deletable ? '미사용' : '확인 필요', enum: true }, { value: network => network.containers.length }, null]);
  const filtered = networkRows.rows;
  useEffect(() => { setPage(0); }, [networkRows.revision]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 50) - 1));
  const selected = query.data?.find(network => network.id === selectedId) ?? null;
  const create = async () => {
    if (busy || inFlight.current || !name.trim()) return;
    inFlight.current = true; setWorking(true); setOperation(null);
    try {
      const result = await backend<{ id: string; name: string }>('network_create', { name: name.trim(), internal });
      setOperation({ tone: 'success', message: t("{p1} 네트워크를 만들었습니다.", { p1: result.name }) });
      setName(''); setInternal(false); setShowCreate(false); setSelectedId(result.id);
    } catch (error) { setOperation({ tone: 'danger', message: t("네트워크 생성 실패: {p1}", { p1: errorMessage(error) }) }); }
    finally { await refreshDashboardAfterMutation(); inFlight.current = false; setWorking(false); }
  };
  const inspect = async (network: Network) => {
    const current = ++generation.current;
    setValidating(true); setPreview(null); setAcknowledged(false); setDialogError(null);
    try {
      const result = await backend<NetworkPreview>('network_delete_preview', { id: network.id });
      if (generation.current === current) setPreview(result);
    } catch (error) { if (generation.current === current) setDialogError(errorMessage(error)); }
    finally { if (generation.current === current) setValidating(false); }
  };
  const prepare = (network: Network) => {
    if (busy || blockedReason(network)) return;
    setTarget(network); void inspect(network);
  };
  const cancel = () => {
    if (inFlight.current || executing) return;
    generation.current += 1; setTarget(null); setPreview(null); setValidating(false); setAcknowledged(false); setDialogError(null);
  };
  const execute = async () => {
    if (!preview || !acknowledged || validating || inFlight.current) return;
    if (preview.expiresAt <= Date.now()) { setPreview(null); setAcknowledged(false); setDialogError(t("승인 정보가 만료되었습니다. 대상을 다시 검사하세요.")); return; }
    inFlight.current = true; setExecuting(true); setDialogError(null);
    try {
      const result = await backend<DestructiveResult>('network_delete_execute', { token: preview.token, approved: true });
      setOperation({ tone: result.failed.length ? 'danger' : 'success', message: result.failed.length ? result.failed.map(failure => `${failure.id}: ${failure.error}`).join(' / ') : t("{p1} 네트워크를 삭제했습니다.", { p1: preview.network.name }) });
      setTarget(null); setPreview(null); setAcknowledged(false);
    } catch (error) { setDialogError(errorMessage(error)); setPreview(null); setAcknowledged(false); }
    finally { await refreshDashboardAfterMutation(); inFlight.current = false; setExecuting(false); }
  };
  const buttons = <><button className="button primary" disabled={busy || props.engine?.state !== 'connected'} aria-expanded={showCreate} onClick={() => setShowCreate(value => !value)}>{t("네트워크 만들기")}</button></>;
  return <>
    {props.noPageHeader ? <div className="section-heading"><h2>{t("네트워크")}</h2><div className="header-actions"><button className="button primary" disabled={busy || props.engine?.state !== 'connected'} aria-expanded={showCreate} onClick={() => setShowCreate(value => !value)}>{t("네트워크 만들기")}</button></div></div> : <PageHeader title={t("Networks")}>{buttons}</PageHeader>}
    <OperationNotice operation={operation} onDismiss={() => setOperation(null)} />
    <EngineGate {...props}>
      {showCreate && <section className="panel" style={{ marginBottom: 16 }} aria-label={t("네트워크 만들기")}><form className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }} onSubmit={event => { event.preventDefault(); void create(); }}><div className="field"><label htmlFor="network-name">{t("새 네트워크 이름")}</label><input id="network-name" className="text-input" value={name} maxLength={63} disabled={busy} onChange={event => setName(event.target.value)} placeholder={t("예: project-network")} spellCheck={false} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,62}" /></div><label className="checkbox-control" style={{ marginBottom: 9 }}><input type="checkbox" checked={internal} disabled={busy} onChange={event => setInternal(event.target.checked)} />{t("외부 통신 차단 (Internal)")}</label><button className="button primary" disabled={busy || !name.trim()}>{t("만들기")}</button><button type="button" className="button" disabled={busy} onClick={() => setShowCreate(false)}>{t("닫기")}</button></form><p className="usage-note" style={{ marginTop: 12 }}>{t("로컬 bridge 네트워크를 만듭니다. IP 대역은 엔진이 사용 가능한 범위에서 할당합니다.")}</p></section>}
      <div className="toolbar"><SearchInput value={search} onChange={setSearch} placeholder={t("네트워크 이름, 드라이버, ID, 컨테이너 검색…")} /></div>
      {query.error && <ErrorNotice message={query.error} onRetry={() => void query.reload()} />}
      {query.loading && !query.data ? <StatePanel busy title={t("네트워크 조회 중")} /> : query.data?.length === 0 ? <StatePanel icon="containers" title={t("네트워크가 없습니다")} description={t("네트워크 만들기로 컨테이너 간 연결을 추가하세요.")} /> : query.data && <div className={`split-view ${selected ? 'with-detail' : ''}`}><div className="list-pane"><TableFilters controls={networkRows} labels={{1:t("드라이버"),2:t("범위")}} /><div className="table-wrap"><ResizableTable storageKey="networks" controls={networkRows} widths={[270,120,120,370,100]} className="data-table" aria-label={t("네트워크 목록")}><thead><tr><th>{t("이름")}</th><th>{t("드라이버")}</th><th>{t("범위")}</th><th>{t("컨테이너 참조")}</th><th style={{ width: 76 }}>{t("작업")}</th></tr></thead><tbody>{filtered.slice(currentPage * 50, (currentPage + 1) * 50).map(network => {
        const reason = blockedReason(network);
        return <tr key={network.id} className={selectedId === network.id ? 'selected' : ''}><td><button className="inline-link" onClick={() => setSelectedId(network.id)}>{network.name}</button><span className="cell-subtext mono" >{network.id}</span></td><td>{network.driver}{network.internal && <span className="cell-subtext">{t("Internal")}</span>}</td><td><span ><StatusBadge tone={network.builtin ? 'muted' : network.containers.length ? 'accent' : 'success'}>{network.builtin ? t("기본") : network.containers.length ? t("참조 중") : network.deletable ? t("미사용") : t("확인 필요")}</StatusBadge></span></td><td>{network.containers.length ? <ContainerReferences containers={network.containers} /> : t("없음")}</td><td><span ><button className="icon-button danger" disabled={busy || query.loading || !!reason} onClick={() => prepare(network)} data-tooltip={reason ?? t("네트워크 삭제 확인")} aria-label={t("{p1} 네트워크 삭제 확인", { p1: network.name })}><Icon name="trash" size={16} /></button></span></td></tr>;
      })}</tbody></ResizableTable></div><Pagination page={currentPage} count={filtered.length} onPage={setPage} />{filtered.length === 0 && <StatePanel icon="search" title={t("검색 결과가 없습니다")} />}</div>
        {selected && <DetailPanel title={selected.name} onClose={() => setSelectedId(null)}><div className="detail-content"><dl className="detail-meta"><dt>ID</dt><dd className="mono selectable">{selected.id}</dd><dt>{t("드라이버")}</dt><dd>{selected.driver} · {selected.scope}</dd><dt>{t("외부 통신")}</dt><dd>{selected.internal ? t("차단됨 (Internal)") : t("네트워크 설정에 따름")}</dd><dt>IPAM</dt><dd>{selected.ipam?.Driver ?? t("미확인")}</dd></dl><h3 style={{ margin: '18px 0 10px' }}>{t("참조 컨테이너")}</h3>{selected.containers.length ? <ul className="dialog-target-list">{selected.containers.map(container => <li key={container.id}><strong>{container.name}</strong> · {container.state}<small className="mono selectable">{container.id}</small></li>)}</ul> : <p className="muted">{t("참조하는 컨테이너가 없습니다.")}</p>}<h3 style={{ margin: '18px 0 10px' }}>{t("할당된 IP 대역")}</h3>{selected.ipam?.Config?.length ? <dl className="detail-meta">{selected.ipam.Config.map((config, index) => <div key={index} style={{ display: 'contents' }}><dt>Subnet</dt><dd className="mono selectable">{config.Subnet ?? t("미확인")}</dd><dt>Gateway</dt><dd className="mono selectable">{config.Gateway ?? t("없음")}</dd>{config.IPRange && <><dt>IP range</dt><dd className="mono selectable">{config.IPRange}</dd></>}</div>)}</dl> : <p className="muted">{t("할당된 IP 대역이 없습니다.")}</p>}<details style={{ margin: '16px 0' }}><summary>{t("IPAM 설정 상세")}</summary><pre className="logs" style={{ height: 'auto', maxHeight: 220 }}>{JSON.stringify(selected.ipam, null, 2)}</pre></details>{blockedReason(selected) && <p className="usage-note">{blockedReason(selected)}</p>}<div className="detail-actions"><button className="button small danger-button" disabled={busy || !!blockedReason(selected)} data-tooltip={blockedReason(selected) ?? t("네트워크 삭제 확인")} onClick={() => prepare(selected)}>{t("삭제…")}</button></div></div></DetailPanel>}
      </div>}
    </EngineGate>
    {target && <ConfirmDialog title={t("네트워크 삭제 확인")} label={t("네트워크 삭제")} busy={executing} ready={!validating && !!preview} error={dialogError} acknowledged={acknowledged} onAcknowledge={setAcknowledged} onCancel={cancel} onConfirm={() => void execute()}><p>{t("다음 네트워크만 삭제합니다.")}</p><div className="dialog-target">{preview?.network.name ?? target.name}<small>{target.id}</small></div><p>{t("네트워크 설정을 삭제하며 컨테이너, 이미지, 볼륨은 유지합니다. 다시 만들면 네트워크 ID와 IP 대역이 달라질 수 있습니다.")}</p><p className="danger">{t("이 작업은 DockSlate에서 되돌릴 수 없습니다.")}</p>{validating && <p className="loading-line" role="status">{t("현재 네트워크와 모든 컨테이너 참조를 검사하고 있습니다.")}</p>}{preview && <p className="usage-note">{t("승인 만료:") + " "}{new Date(preview.expiresAt).toLocaleTimeString(getLocale())}</p>}{!validating && !preview && <button className="button small" disabled={executing} onClick={() => void inspect(target)}>{t("대상 다시 검사")}</button>}</ConfirmDialog>}
  </>;
}
