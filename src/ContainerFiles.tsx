import { useCallback, useEffect, useRef, useState } from 'react';
import { backend, type Container } from './api';
import { errorMessage, formatBytes, Icon } from './components';

type Entry = { name: string; path: string; kind: 'directory' | 'file' | 'symlink' | 'other'; size: number | null; modifiedAt: number | null };
type Directory = { path: string; entries: Entry[]; truncated: boolean };
type Preview = { path: string; content: string; binary: boolean; truncated: boolean; bytes: number };

export function ContainerFiles({ container, revision, active = true }: { container: Container; revision: number; active?: boolean }) {
  const [path, setPath] = useState('/');
  const [input, setInput] = useState('/');
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const directories = useRef(new Map<string, Directory>());
  const previews = useRef(new Map<string, Preview>());
  const request = useRef(0);
  const identity = useRef(`${container.id}:${revision}`);
  const containerIdentity = useRef(container.id);
  const load = useCallback(async (target: string, force = false) => {
    const cached = !force ? directories.current.get(target) : undefined;
    setPath(target); setInput(target); setPreview(null); setFailure(null);
    const token = ++request.current;
    if (cached) { setDirectory(cached); setBusy(false); return; }
    setDirectory(null); setBusy(true);
    try {
      const value = await backend<Directory>('container_files', { id: container.id, path: target });
      if (request.current !== token) return;
      directories.current.set(target, value); setDirectory(value); setPath(value.path); setInput(value.path);
    } catch (error) { if (request.current === token) setFailure(errorMessage(error)); }
    finally { if (request.current === token) setBusy(false); }
  }, [container.id]);
  useEffect(() => {
    const key = `${container.id}:${revision}`;
    const target = containerIdentity.current !== container.id ? '/' : path;
    containerIdentity.current = container.id;
    if (identity.current !== key) { identity.current = key; directories.current.clear(); previews.current.clear(); request.current++; setDirectory(null); setPreview(null); }
    if (active && !directories.current.has(target)) void load(target);
  }, [active, container.id, revision, load]);
  useEffect(() => () => { request.current++; }, []);
  const openFile = async (entry: Entry) => {
    if (entry.kind === 'directory') { await load(entry.path); return; }
    if (entry.kind !== 'file') return;
    const cached = previews.current.get(entry.path);
    const token = ++request.current;
    setFailure(null);
    if (cached) { setPreview(cached); return; }
    setBusy(true);
    try {
      const value = await backend<Preview>('container_file_preview', { id: container.id, path: entry.path });
      if (request.current !== token) return;
      previews.current.set(entry.path, value); setPreview(value);
    } catch (error) { if (request.current === token) setFailure(errorMessage(error)); }
    finally { if (request.current === token) setBusy(false); }
  };
  const parent = path === '/' ? '/' : path.substring(0, path.lastIndexOf('/')) || '/';
  return <section aria-label="컨테이너 파일" style={{ display: 'grid', gap: 14 }}>
    <p className="muted">중지된 컨테이너의 파일도 조회할 수 있습니다. 심볼릭 링크와 장치 파일은 읽지 않으며 텍스트는 최대 512KB까지 표시합니다. 중지 상태의 폴더 조회는 16MB까지 지원합니다. 큰 폴더는 하위 경로를 직접 입력하세요.</p>
    <form className="toolbar" onSubmit={event => { event.preventDefault(); if (!busy) void load(input); }}>
      <button type="button" className="button" disabled={busy || path === '/'} onClick={() => void load(parent)}>상위 폴더</button>
      <input className="text-input" aria-label="컨테이너 파일 경로" value={input} onChange={event => setInput(event.target.value)} placeholder="/" style={{ flex: 1, minWidth: 100 }} />
      <button className="button" disabled={busy}>이동</button>
      <button type="button" className="button" disabled={busy} onClick={() => void load(path, true)} aria-label="컨테이너 폴더 새로고침"><Icon name="refresh" /></button>
    </form>
    {failure && <div className="notice error" role="alert">{failure}</div>}
    {busy && <p role="status" className="muted">파일을 읽는 중…</p>}
    {directory && <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}><table className="data-table" aria-label="컨테이너 파일 목록"><thead><tr><th>이름</th><th>종류</th><th>크기</th></tr></thead><tbody>{directory.entries.map(entry => <tr key={entry.path}><td><button className="button subtle" disabled={busy || !['directory', 'file'].includes(entry.kind)} onClick={() => void openFile(entry)} title={entry.path}>{entry.kind === 'directory' ? '▸ ' : ''}{entry.name}</button></td><td>{({ directory: '폴더', file: '파일', symlink: '심볼릭 링크', other: '기타' })[entry.kind]}</td><td>{entry.kind === 'file' ? formatBytes(entry.size) : ''}</td></tr>)}</tbody></table>{directory.entries.length === 0 && <p className="muted" style={{ padding: 16 }}>폴더가 비어 있습니다.</p>}</div>}
    {directory?.truncated && <p className="warning">처음 256개 항목만 표시했습니다. 하위 폴더로 이동하거나 경로를 직접 입력하세요.</p>}
    {preview && <section aria-label="컨테이너 파일 미리보기"><div className="toolbar"><strong style={{ overflowWrap: 'anywhere', flex: 1 }}>{preview.path}</strong><button className="button subtle" onClick={() => setPreview(null)}>닫기</button></div>{preview.binary ? <p className="muted">바이너리 파일 또는 UTF-8이 아닌 파일은 미리보기할 수 없습니다.</p> : <pre style={{ userSelect: 'text', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto', padding: 16, background: 'var(--bg, #0b1016)', borderRadius: 6 }}>{preview.content || '(빈 파일)'}</pre>}{preview.truncated && <p className="warning">파일의 처음 512KB만 표시했습니다.</p>}</section>}
  </section>;
}
