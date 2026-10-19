import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { type Container } from './api';
import { ErrorNotice, Icon, SearchInput, errorMessage } from './components';
import { t } from "./i18n";
import { readMetadata } from './metadataCache';


const sections = ['전체', 'State', 'Config', 'HostConfig', 'Mounts', 'NetworkSettings', 'GraphDriver'];
function JsonText({ content }: { content: string }) {
  const lines = useMemo(() => content.split('\n'), [content]);
  const [scroll, setScroll] = useState(0);
  const [view, setView] = useState<HTMLDivElement | null>(null);
  useEffect(() => { if (view) view.scrollTop = 0; setScroll(0); }, [content, view]);
  const start = Math.max(0, Math.floor(scroll / 20) - 12);
  const end = Math.min(lines.length, start + 48);
  return <div ref={setView} className="inspect-json selectable" tabIndex={0} aria-label={t("컨테이너 Inspect JSON")} onScroll={event => setScroll(event.currentTarget.scrollTop)} style={{ height: Math.min(420, Math.max(80, lines.length * 20)), padding: '0 14px', position: 'relative' }}><div style={{ height: lines.length * 20, position: 'relative' }}><pre style={{ position: 'absolute', top: start * 20, margin: 0, font: 'inherit', lineHeight: '20px', whiteSpace: 'pre', minWidth: '100%' }}>{lines.slice(start, end).join('\n')}</pre></div></div>;
}
export function ContainerInspect({ container, revision, active = true, focusSection }: { container: Container; revision: number; active?: boolean; focusSection?: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState('전체');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [copied, setCopied] = useState(false);
  const request = useRef(0);
  const read = async () => {
    const current = ++request.current;
    setLoading(true); setError(null);
    try { const value = await readMetadata<Record<string, unknown>>('container_inspect', container.id, revision); if (request.current === current) setData(value); }
    catch (failure) { if (request.current === current) setError(errorMessage(failure)); }
    finally { if (request.current === current) setLoading(false); }
  };
  useEffect(() => () => { request.current++; }, []);
  const [loadedRevision, setLoadedRevision] = useState(-1);
  useEffect(() => { if (active && loadedRevision !== revision) { setLoadedRevision(revision); void read(); } }, [container.id, revision, active]);
  useEffect(() => { if (focusSection) setSection(focusSection); }, [focusSection]);
  const json = useMemo(() => {
    if (!data) return '';
    const value = section === '전체' ? data : { [section]: data[section] };
    return JSON.stringify(value, null, 2);
  }, [data, section]);
  const content = useMemo(() => deferredSearch ? json.split('\n').filter(line => line.toLowerCase().includes(deferredSearch)).join('\n') : json, [json, deferredSearch]);
  return <div className="container-inspect"><div className="detail-content"><div className="toolbar"><SearchInput value={search} onChange={setSearch} placeholder={t("설정 키와 값 검색…")} /><button className="button small" disabled={!content} onClick={() => { void navigator.clipboard.writeText(content).then(() => setCopied(true)).catch(failure => setError(errorMessage(failure))); }}><Icon name="copy" size={14} />{copied ? t("복사됨") : t("복사")}</button></div><div className="inspect-sections">{sections.map(name => <button className={`button small ${section === name ? 'primary' : ''}`} key={name} disabled={!data} onClick={() => { setSection(name); setCopied(false); }}>{name === '전체' ? t('전체') : name}</button>)}</div>{error && <ErrorNotice message={error} onRetry={() => void read()} />}{loading && <p className="usage-note" role="status">{t("설정 정보를 확인하고 있습니다.")}</p>}</div><JsonText content={content || (loading ? t('조회 중…') : error ? t('설정을 조회할 수 없습니다.') : t('검색 결과가 없습니다.'))} /></div>;
}
