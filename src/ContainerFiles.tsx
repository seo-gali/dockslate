import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { type Container } from './api';
import { errorMessage, formatBytes, Icon } from './components';
import { cachedContainerFiles, readContainerDirectory, readContainerFilePreview, rememberContainerDirectory, type ContainerDirectory, type ContainerFileEntry, type ContainerFilePreview } from './containerFilesCache';
import './container-files.css';
import { t } from "./i18n";


type Node = { directory?: ContainerDirectory; loading?: boolean; error?: string };
const parentPath = (path: string) => path === '/' ? '/' : path.substring(0, path.lastIndexOf('/')) || '/';
function ancestors(path: string): string[] {
  const values = ['/'];
  let target = '';
  for (const part of path.split('/').filter(Boolean)) { target += `/${part}`; values.push(target); }
  return values;
}
function normalizedPath(path: string): string {
  if (!path.startsWith('/') || path.length > 4096 || path.includes('\0') || path.split('/').some(part => part === '.' || part === '..') || path.split('/').filter(Boolean).length > 32) throw new Error('/로 시작하는 경로를 입력하세요. . 또는 .. 경로는 사용할 수 없습니다.');
  return `/${path.split('/').filter(Boolean).join('/')}`;
}
function initialNodes(id: string, revision: number): Record<string, Node> { return Object.fromEntries([...cachedContainerFiles(id, revision).directories].map(([path, directory]) => [path, { directory }])); }
function updateNode(nodes: Record<string, Node>, path: string, value: Node) {
  const next = { ...nodes };
  delete next[path]; next[path] = value;
  while (Object.keys(next).length > 96) {
    const oldest = Object.keys(next).find(key => key !== '/' && key !== path);
    if (!oldest) break;
    delete next[oldest];
  }
  return next;
}

export function ContainerFiles({ container, revision, active = true }: { container: Container; revision: number; active?: boolean }) {
  const scope = `${container.id}:${revision}`;
  const initial = useRef(cachedContainerFiles(container.id, revision));
  const [path, setPath] = useState(initial.current.path);
  const [input, setInput] = useState(initial.current.path);
  const [nodes, setNodes] = useState<Record<string, Node>>(() => initialNodes(container.id, revision));
  const [directory, setDirectory] = useState<ContainerDirectory | null>(() => initial.current.directories.get(initial.current.path) ?? null);
  const [expanded, setExpanded] = useState(() => new Set(ancestors(initial.current.path)));
  const [focusPath, setFocusPath] = useState(initial.current.path);
  const [preview, setPreview] = useState<ContainerFilePreview | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [previewFailure, setPreviewFailure] = useState<string | null>(null);
  const selected = useRef(initial.current.path);
  const selectedRequest = useRef(0);
  const previewRequest = useRef(0);
  const nodeRequests = useRef(new Map<string, number>());
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const sequence = useRef(0);
  const live = useRef({ scope, active, epoch: 0, mounted: true });
  const previousScope = useRef(scope);
  const treeId = useId();
  if (live.current.scope !== scope || live.current.active !== active) live.current = { ...live.current, scope, active, epoch: live.current.epoch + 1 };
  const current = (epoch: number) => live.current.mounted && live.current.active && live.current.scope === scope && live.current.epoch === epoch;

  const readNode = useCallback(async (target: string, force = false) => {
    const epoch = live.current.epoch;
    const token = ++sequence.current;
    nodeRequests.current.set(target, token);
    setNodes(previous => updateNode(previous, target, { ...previous[target], loading: true, error: undefined }));
    try {
      const value = await readContainerDirectory(container.id, revision, target, force);
      if (current(epoch) && nodeRequests.current.get(target) === token) setNodes(previous => updateNode(previous, target, { directory: value }));
      return value;
    } catch (error) {
      if (current(epoch) && nodeRequests.current.get(target) === token) setNodes(previous => updateNode(previous, target, { ...previous[target], loading: false, error: errorMessage(error) }));
      throw error;
    } finally { if (nodeRequests.current.get(target) === token) nodeRequests.current.delete(target); }
  }, [container.id, revision, scope]);
  const load = useCallback(async (target: string, force = false) => {
    let normalized: string;
    try { normalized = normalizedPath(target); }
    catch (error) { setFailure(errorMessage(error)); return; }
    const epoch = live.current.epoch;
    const token = ++selectedRequest.current;
    previewRequest.current++;
    selected.current = normalized;
    setPath(normalized); setInput(normalized); setPreview(null); setFilePath(null); setPreviewFailure(null); setPreviewLoading(false); setFailure(null);
    setExpanded(previous => new Set([...previous, ...ancestors(normalized).slice(0, -1), '/']));
    const cached = !force ? cachedContainerFiles(container.id, revision).directories.get(normalized) : undefined;
    setDirectory(cached ?? null); setLoading(!cached);
    try {
      const value = await readNode(normalized, force);
      if (!current(epoch) || selectedRequest.current !== token) return;
      setDirectory(value); setPath(value.path); setInput(value.path); selected.current = value.path;
      rememberContainerDirectory(container.id, revision, value.path);
    } catch (error) { if (current(epoch) && selectedRequest.current === token) setFailure(errorMessage(error)); }
    finally { if (current(epoch) && selectedRequest.current === token) setLoading(false); }
  }, [container.id, revision, readNode, scope]);

  useEffect(() => {
    live.current.mounted = true;
    const changed = previousScope.current !== scope;
    previousScope.current = scope;
    if (changed) {
      const cached = cachedContainerFiles(container.id, revision);
      selected.current = cached.path;
      setPath(cached.path); setInput(cached.path); setExpanded(new Set(ancestors(cached.path))); setFocusPath(cached.path);
      setNodes(initialNodes(container.id, revision)); setDirectory(cached.directories.get(cached.path) ?? null);
      setPreview(null); setFilePath(null); setFailure(null); setPreviewFailure(null);
    } else setNodes(previous => Object.fromEntries(Object.entries(previous).map(([target, node]) => [target, { ...node, loading: false }])));
    if (active) void load(selected.current);
    else { setLoading(false); setPreviewLoading(false); }
    return () => { live.current.epoch++; selectedRequest.current++; previewRequest.current++; };
  }, [active, container.id, revision, scope, load]);
  useEffect(() => () => { live.current.mounted = false; live.current.epoch++; }, []);

  const openFile = async (entry: ContainerFileEntry) => {
    if (entry.kind === 'directory') { await load(entry.path); return; }
    if (entry.kind !== 'file' || !active) return;
    const token = ++previewRequest.current;
    const epoch = live.current.epoch;
    setFilePath(entry.path); setPreview(null); setPreviewFailure(null); setPreviewLoading(true);
    try {
      const value = await readContainerFilePreview(container.id, revision, entry.path);
      if (current(epoch) && previewRequest.current === token) setPreview(value);
    } catch (error) { if (current(epoch) && previewRequest.current === token) setPreviewFailure(errorMessage(error)); }
    finally { if (current(epoch) && previewRequest.current === token) setPreviewLoading(false); }
  };
  const toggle = (target: string) => {
    if (expanded.has(target)) { setExpanded(previous => { const value = new Set(previous); value.delete(target); return value; }); return; }
    setExpanded(previous => new Set(previous).add(target));
    if (!nodes[target]?.directory && !nodes[target]?.loading) void readNode(target).catch(() => undefined);
  };
  const implicit = new Set([...ancestors(path), ...expanded]);
  const children = (target: string) => {
    const paths = new Set(nodes[target]?.directory?.entries.filter(entry => entry.kind === 'directory').map(entry => entry.path) ?? []);
    for (const candidate of implicit) if (candidate !== '/' && parentPath(candidate) === target) paths.add(candidate);
    return [...paths].sort((left, right) => left.localeCompare(right));
  };
  const visible: string[] = [];
  const flatten = (target: string) => { visible.push(target); if (expanded.has(target)) children(target).forEach(flatten); };
  flatten('/');
  const focus = (target: string) => { setFocusPath(target); itemRefs.current.get(target)?.focus(); };
  const keyboard = (event: KeyboardEvent<HTMLLIElement>, target: string) => {
    if (event.target !== event.currentTarget) return;
    const index = visible.indexOf(target);
    if (event.key === 'ArrowDown') focus(visible[Math.min(index + 1, visible.length - 1)]);
    else if (event.key === 'ArrowUp') focus(visible[Math.max(index - 1, 0)]);
    else if (event.key === 'Home') focus('/');
    else if (event.key === 'End') focus(visible[visible.length - 1]);
    else if (event.key === 'ArrowRight') { if (!expanded.has(target)) toggle(target); else if (children(target).length) focus(children(target)[0]); }
    else if (event.key === 'ArrowLeft') { if (expanded.has(target)) toggle(target); else focus(parentPath(target)); }
    else if (event.key === 'Enter' || event.key === ' ') void load(target);
    else return;
    event.preventDefault(); event.stopPropagation();
  };
  const renderNode = (target: string, depth: number) => {
    const node = nodes[target];
    const descendants = children(target);
    const canExpand = !node?.directory || node.directory.truncated || descendants.length > 0;
    const isExpanded = expanded.has(target) && canExpand;
    const group = `${treeId}-${encodeURIComponent(target)}`;
    return <li key={target} role="treeitem" aria-selected={path === target} aria-expanded={canExpand ? isExpanded : undefined} tabIndex={focusPath === target || (!visible.includes(focusPath) && target === '/') ? 0 : -1} className="container-files-tree-item" ref={element => { if (element) itemRefs.current.set(target, element); else itemRefs.current.delete(target); }} onFocus={event => { if (event.target === event.currentTarget) setFocusPath(target); }} onKeyDown={event => keyboard(event, target)}>
      <div className={`container-files-tree-row${path === target ? ' selected' : ''}`} style={{ paddingLeft: 8 + depth * 13 }}>
        <button type="button" tabIndex={-1} className="container-files-disclosure" disabled={!canExpand} aria-label={`${isExpanded ? t('폴더 접기') : t('폴더 펼치기')}: ${target}`} aria-expanded={canExpand ? isExpanded : undefined} aria-controls={isExpanded ? group : undefined} onClick={() => { focus(target); toggle(target); }}>{node?.loading ? <Icon name="refresh" size={12} /> : canExpand ? isExpanded ? '▾' : '▸' : <span />}</button>
        <button type="button" tabIndex={-1} className="container-files-tree-name" onClick={() => { focus(target); void load(target); }} title={target}>{target === '/' ? '/' : target.slice(target.lastIndexOf('/') + 1)}</button>
      </div>
      {isExpanded && <ul role="group" id={group}>{node?.error && <li role="none" className="container-files-tree-error" style={{ paddingLeft: 20 + depth * 13 }}><span role="alert">{node.error}</span><button type="button" className="button subtle small" onClick={() => void readNode(target).catch(() => undefined)}>{t("다시 시도")}</button></li>}{!node?.loading && node?.directory && descendants.length === 0 && <li role="none" className="container-files-tree-empty">{t("하위 폴더 없음")}</li>}{descendants.map(child => renderNode(child, depth + 1))}{node?.directory?.truncated && <li role="none" className="container-files-tree-limit">{t("일부 폴더만 표시")}</li>}</ul>}
    </li>;
  };
  const closePreview = () => { previewRequest.current++; setFilePath(null); setPreview(null); setPreviewLoading(false); setPreviewFailure(null); };
  return <section className="container-files-browser" aria-label={t("컨테이너 파일")}>
    <aside className="container-files-tree" aria-label={t("폴더 탐색")}><div className="container-files-tree-heading">{t("폴더")}</div><ul role="tree" aria-label={t("컨테이너 폴더")}>{renderNode('/', 0)}</ul></aside>
    <div className="container-files-main">
      <form className="container-files-toolbar" onSubmit={event => { event.preventDefault(); void load(input); }}>
        <button type="button" className="button small" disabled={path === '/' || !active} onClick={() => void load(parentPath(path))} title={t("상위 폴더")} aria-label={t("상위 폴더")}>↑</button>
        <input className="text-input mono" aria-label={t("컨테이너 파일 경로")} value={input} onChange={event => setInput(event.target.value)} placeholder="/" maxLength={4096} />
        <button className="button small" disabled={!active}>{t("이동")}</button><button type="button" className="button small" disabled={loading || !active} onClick={() => void load(path, true)} aria-label={t("컨테이너 폴더 새로고침")} title={t("새로고침")}><Icon name="refresh" size={15} /></button>
      </form>
      {failure && <div className="notice error" role="alert">{failure}</div>}
      <div className="container-files-list table-wrap" aria-busy={loading}>
        <table className="data-table" aria-label={t("컨테이너 파일 목록")}><thead><tr><th>{t("이름")}</th><th>{t("종류")}</th><th>{t("크기")}</th></tr></thead><tbody>{directory?.entries.map(entry => <tr key={entry.path} className={filePath === entry.path ? 'container-files-selected' : undefined}><td><button type="button" className="container-files-entry" disabled={!active || !['directory', 'file'].includes(entry.kind)} onClick={() => void openFile(entry)} title={entry.path}><span aria-hidden="true" className="container-files-kind">{entry.kind === 'directory' ? '▸' : entry.kind === 'symlink' ? '↗' : '·'}</span><span className="container-files-entry-name">{entry.name}</span></button></td><td>{t(({ directory: '폴더', file: '파일', symlink: '링크', other: '기타' })[entry.kind])}</td><td>{entry.kind === 'file' ? formatBytes(entry.size) : '—'}</td></tr>)}</tbody></table>
        {loading && <p className="container-files-empty muted" role="status">{t("폴더를 읽는 중…")}</p>}{!loading && directory?.entries.length === 0 && <p className="container-files-empty muted">{t("빈 폴더")}</p>}
      </div>
      {directory?.truncated && <p className="container-files-limit warning">{t("처음 256개 항목만 표시합니다.")}</p>}
      {filePath && <section className="container-files-preview" aria-label={t("컨테이너 파일 미리보기")} aria-busy={previewLoading}><div className="container-files-preview-heading"><strong className="mono" title={filePath}>{filePath}</strong><button type="button" className="icon-button" onClick={closePreview} aria-label={t("미리보기 닫기")} title={t("닫기")}><Icon name="close" size={14} /></button></div>{previewLoading && <p className="container-files-empty muted" role="status">{t("파일을 읽는 중…")}</p>}{previewFailure && <p className="container-files-empty danger" role="alert">{previewFailure}</p>}{preview && (preview.binary ? <p className="container-files-empty muted">{t("바이너리 또는 UTF-8이 아닌 파일입니다.")}</p> : <pre tabIndex={0}>{preview.content || t("(빈 파일)")}</pre>)}{preview?.truncated && <p className="container-files-limit warning">{t("처음 512 KiB만 표시합니다.")}</p>}</section>}
    </div>
  </section>;
}
