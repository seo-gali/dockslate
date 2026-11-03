import { useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { backend, type Container } from './api';
import { ErrorNotice, Icon, SearchInput, errorMessage } from './components';
import { t } from "./i18n";


const sections = ['전체', 'State', 'Config', 'HostConfig', 'Mounts', 'NetworkSettings', 'GraphDriver'];
function JsonText({ content }: { content: string }) {
  const view = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = view.current;
    if (!element) return;
    let count = 1;
    for (let offset = content.indexOf('\n'); offset >= 0; offset = content.indexOf('\n', offset + 1)) count++;
    const starts = new Uint32Array(count + 1);
    let row = 1;
    for (let offset = content.indexOf('\n'); offset >= 0; offset = content.indexOf('\n', offset + 1)) starts[row++] = offset + 1;
    starts[count] = content.length;
    const spacer = element.firstElementChild as HTMLDivElement;
    const text = spacer.firstElementChild as HTMLPreElement;
    element.scrollTop = 0;
    element.style.height = Math.min(420, Math.max(80, count * 20)) + 'px';
    spacer.style.height = count * 20 + 'px';
    const render = () => {
      const start = Math.max(0, Math.floor(element.scrollTop / 20) - 12);
      const end = Math.min(count, start + 48);
      text.style.top = start * 20 + 'px';
      text.textContent = content.slice(starts[start], end < count ? starts[end] - 1 : content.length);
    };
    render();
    element.addEventListener('scroll', render, { passive: true });
    return () => element.removeEventListener('scroll', render);
  }, [content]);
  return <div ref={view} className="inspect-json selectable" tabIndex={0} aria-label={t("컨테이너 Inspect JSON")} style={{ height: 80, padding: '0 14px', position: 'relative' }}><div style={{ height: 0, position: 'relative' }}><pre style={{ position: 'absolute', top: 0, margin: 0, font: 'inherit', lineHeight: '20px', whiteSpace: 'pre', minWidth: '100%' }} /></div></div>;
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
  const [loadedRevision, setLoadedRevision] = useState(-1);
  const read = async () => {
    const current = ++request.current;
    setLoading(true); setError(null);
    try { const value = await backend<Record<string, unknown>>('container_inspect', { id: container.id }); if (request.current === current) { setData(value); setLoadedRevision(revision); } }
    catch (failure) { if (request.current === current) setError(errorMessage(failure)); }
    finally { if (request.current === current) setLoading(false); }
  };
  useEffect(() => {
    if (active && loadedRevision !== revision) void read();
    if (!active) setLoading(false);
    return () => { request.current++; };
  }, [container.id, revision, active]);
  useEffect(() => { if (focusSection) setSection(focusSection); }, [focusSection]);
  const json = (() => {
    if (!data) return '';
    const value = section === '전체' ? data : { [section]: data[section] };
    return JSON.stringify(value, null, 2);
  })();
  const content = deferredSearch ? json.split('\n').filter(line => line.toLowerCase().includes(deferredSearch)).join('\n') : json;
  return <div className="container-inspect"><div className="detail-content"><div className="toolbar"><SearchInput value={search} onChange={setSearch} placeholder={t("설정 키와 값 검색…")} /><button className="button small" disabled={!content} onClick={() => { void navigator.clipboard.writeText(content).then(() => setCopied(true)).catch(failure => setError(errorMessage(failure))); }}><Icon name="copy" size={14} />{copied ? t("복사됨") : t("복사")}</button></div><div className="inspect-sections">{sections.map(name => <button className={`button small ${section === name ? 'primary' : ''}`} key={name} disabled={!data} onClick={() => { setSection(name); setCopied(false); }}>{name === '전체' ? t('전체') : name}</button>)}</div>{error && <ErrorNotice message={error} onRetry={() => void read()} />}{loading && <p className="usage-note" role="status">{t("설정 정보를 확인하고 있습니다.")}</p>}</div><JsonText content={content || (loading ? t('조회 중…') : error ? t('설정을 조회할 수 없습니다.') : t('검색 결과가 없습니다.'))} /></div>;
}
