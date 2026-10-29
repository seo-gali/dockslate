import { useEffect, useMemo, useState } from 'react';
import { EngineGate, type EngineProps } from '../App';
import { type CleanupCandidate, type DiskUsage, useBackendQuery } from '../api';
import { ResizableTable, type ResizableColumn } from '../ResizableColumns';
import { TableFilters, useTableRows } from '../TableRows';
import { OperationNotice, useDestructiveAction } from '../actions';
import { ErrorNotice, Icon, Pagination, SearchInput, StatePanel, StatusBadge, formatBytes, formatDate } from '../components';
import { t } from "../i18n";
function candidateDate(value: CleanupCandidate['createdAt']): string {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) / 1000 : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? formatDate(seconds) : t('미확인');
}

export default function DockerUsage(props: EngineProps) {
  const query = useBackendQuery<DiskUsage>('disk_usage', undefined, props.engine?.state === 'connected');
  const columnSpecs: ResizableColumn[] = [
    {id:'selection',width:44,minWidth:44,maxWidth:44}, {id:'type',width:96,minWidth:80,maxWidth:220},
    {id:'target',width:380,minWidth:180,maxWidth:1200}, {id:'created',width:210,minWidth:190,maxWidth:380},
    {id:'size',width:100,minWidth:76,maxWidth:240}, {id:'state',width:140,minWidth:112,maxWidth:320},
  ];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const term = search.trim().toLowerCase();
  const destructive = useDestructiveAction(() => { setSelected(new Set()); });
  const candidates = useMemo(() => [
    ...(query.data?.images ?? []).map(candidate => ({ ...candidate, type: 'Image' as const, key: `image:${candidate.id}` })),
    ...(query.data?.buildCache ?? []).map(candidate => ({ ...candidate, type: 'Build cache' as const, key: `cache:${candidate.id}` })),
  ], [query.data]);
  const matches = useMemo(() => term ? candidates.filter(candidate => `${candidate.id} ${candidate.label} ${candidate.type}`.toLowerCase().includes(term)) : candidates, [candidates, term]);
  const candidateRows = useTableRows(matches, [null, { value: candidate => candidate.type, enum: true }, { value: candidate => candidate.label }, { value: candidate => typeof candidate.createdAt === 'string' ? Date.parse(candidate.createdAt) : candidate.createdAt }, { value: candidate => candidate.size }, { value: candidate => candidate.eligible ? '선택 가능' : '정리 차단', enum: true }]);
  const filtered = candidateRows.rows;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 50) - 1));
  const visible = useMemo(() => filtered.slice(currentPage * 50, (currentPage + 1) * 50), [filtered, currentPage]);
  useEffect(() => { setPage(0); }, [search, candidateRows.revision]);
  const selection = candidates.filter(candidate => selected.has(candidate.key) && candidate.eligible);
  const selectedBytes = selection.every(item => item.size != null) ? selection.reduce((sum, item) => sum + (item.size ?? 0), 0) : null;
  const toggle = (key: string) => setSelected(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const clean = async () => { await destructive.prepare({ kind: 'cleanup', imageIds: selection.filter(candidate => candidate.type === 'Image').map(candidate => candidate.id), buildCacheIds: selection.filter(candidate => candidate.type === 'Build cache').map(candidate => candidate.id) }, selection.map(candidate => `${candidate.label} · ${candidate.id}`)); };
  return <><OperationNotice operation={destructive.operation} onDismiss={() => destructive.setOperation(null)} /><EngineGate {...props}>{query.error && <ErrorNotice message={query.error} onRetry={() => void query.reload()} />}{query.loading && !query.data ? <StatePanel busy title={t("Docker 사용량 분석 중")} description={t("이미지, 빌드 캐시, 컨테이너와 볼륨의 논리 사용량을 조회합니다.")} /> : query.data && <><div className="metrics-grid disk-metrics">{([{ label: 'Images', bytes: query.data.imagesBytes, icon: 'images' }, { label: 'Build cache', bytes: query.data.buildCacheBytes, icon: 'disk' }, { label: 'Containers', bytes: query.data.containersBytes, icon: 'containers' }, { label: 'Volumes', bytes: query.data.volumesBytes, icon: 'disk' }] as const).map(item => <div className="metric" key={item.label}><span className="metric-heading">{t(item.label)}<Icon name={item.icon} size={16} /></span><strong className="metric-value">{formatBytes(item.bytes)}</strong><span className="metric-subtext">{item.label === 'Containers' || item.label === 'Volumes' ? t("자동 정리 대상에서 제외") : t("Docker가 보고한 사용량")}</span></div>)}</div><div className="selection-summary"><div><strong>{t("Docker 정리 가능 추정치") + " "}<span className="accent" style={{ marginLeft: 8 }}>{formatBytes(query.data.reclaimableBytes)}</span></strong><p>{selection.length > 0 ? t("{p1}개 선택 · 선택 대상 크기 합계 {p2}", { p1: selection.length, p2: formatBytes(selectedBytes) }) : t("미사용 이미지와 사용 중이 아닌 빌드 캐시를 선택하세요.")}</p></div><button className="button danger-button" disabled={selection.length === 0 || destructive.busy || props.mutationBlocked || query.loading} onClick={() => void clean()}><Icon name="trash" size={15} />{t("선택한 데이터 정리…")}</button></div><div className="toolbar"><SearchInput value={search} onChange={setSearch} placeholder={t("정리 대상 이름, 종류, ID 검색…")} /><TableFilters controls={candidateRows} labels={{1:t("Type"),5:t("정리 가능 여부")}} /><span className="result-count">{filtered.length}{t("개 대상")}</span></div>{candidates.length === 0 ? <StatePanel icon="disk" title={t("정리 대상이 없습니다")} description={t("엔진에서 이미지와 빌드 캐시를 보고하지 않았습니다. 컨테이너와 볼륨은 자동 정리하지 않습니다.")} /> : matches.length === 0 ? <StatePanel icon="search" title={t("검색 결과가 없습니다")}><button className="button" onClick={() => setSearch('')}>{t("검색 초기화")}</button></StatePanel> : <div className="table-wrap"><ResizableTable storageKey="cleanup" controls={candidateRows} columnSpecs={columnSpecs} className="candidate-table">
  <thead><tr><th className="selection-cell" aria-label={t('선택')}/>
    {[{id:'type',label:t('Type')},{id:'target',label:t('대상')},{id:'created',label:t('Created')},{id:'size',label:t('Size')},{id:'state',label:t('정리 가능 여부')}].map(column => <th key={column.id}>{column.label}</th>)}
  </tr></thead>
  <tbody>{visible.map(candidate => {
    const date = candidateDate(candidate.createdAt);
    return <tr key={candidate.key} className={selected.has(candidate.key) ? 'selected' : ''}>
      <td className="selection-cell"><input type="checkbox" disabled={!candidate.eligible || destructive.busy || props.mutationBlocked || query.loading} checked={selected.has(candidate.key) && candidate.eligible} onChange={() => toggle(candidate.key)} aria-label={t('{p1} 정리 대상 선택', {p1:candidate.label})} data-tooltip={candidate.reason ?? t('정리 대상 선택')}/></td>
      <td className="muted">{t(candidate.type)}</td>
      <td ><span>{candidate.label}</span><span className="cell-subtext">{candidate.reason ? t(candidate.reason) : candidate.id}</span></td>
      <td className="date-cell">{date}</td>
      <td>{formatBytes(candidate.size)}</td>
      <td><StatusBadge tone={candidate.eligible ? 'success' : 'warning'}>{candidate.eligible ? t('선택 가능') : t('정리 차단')}</StatusBadge></td>
    </tr>;
  })}</tbody>
</ResizableTable><Pagination page={currentPage} count={filtered.length} onPage={setPage} /></div>}<p className="usage-note">{t("공유 이미지 레이어로 인해 대상 크기 합계와 실제 Docker 정리량이 다를 수 있습니다. Docker 정리량은 VHDX 파일 크기 감소나 Windows 실제 회수량을 뜻하지 않습니다.")}</p>{query.data.warnings.length > 0 && <div className="notice info" style={{ marginTop: 16 }}><Icon name="warning" /><div><strong>{t("사용량 분석 안내")}</strong>{query.data.warnings.map((warning, index) => <p key={index}>{t(warning)}</p>)}</div></div>}</>}</EngineGate>{destructive.dialog}</>;
}
