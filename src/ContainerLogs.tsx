import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { backend, type Container } from './api';
import { cachedLogs, storeContainerLogs } from './containerReadCache';
import { OperationNotice, type Operation } from './actions';
import { Icon, SearchInput, errorMessage } from './components';
import { getLocale, t } from './i18n';

interface LogEvent { streamId: string; id: string; state: 'streaming' | 'closed' | 'error'; content: string; reset: boolean; truncated: boolean; message?: string; sequence: number }

export default function ContainerLogs({ container, revision, active }: { container: Container; revision: number; active: boolean }) {
  const [entry, setEntry] = useState(() => cachedLogs(container.id));
  const [connection, setConnection] = useState<'connecting' | 'streaming' | 'closed' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(''), [autoScroll, setAutoScroll] = useState(true), [restart, setRestart] = useState(0);
  const [copyOperation, setCopyOperation] = useState<Operation>(null);
  const logsRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!active) return;
    const streamId = crypto.randomUUID();
    let disposed = false, unlisten: (() => void) | undefined, sequence = -1;
    let content = '', truncated = false;
    setConnection('connecting'); setError(null);
    const stop = () => backend('container_logs_stop', {streamId}).catch(() => {});
    const start = async () => {
      try {
        unlisten = await listen<LogEvent>('container-log-stream', event => {
          const next = event.payload;
          if (disposed || next.streamId !== streamId || next.id !== container.id || next.sequence <= sequence) return;
          sequence = next.sequence;
          if (next.reset) { content = ''; truncated = false; }
          if (next.content || next.reset) {
            content += next.content;
            const lines = content.split('\n');
            const lineLimit = content.endsWith('\n') ? 301 : 300;
            if (lines.length > lineLimit) { content = lines.slice(-lineLimit).join('\n'); truncated = true; }
            if (content.length > 512 * 1024) {
              content = content.slice(-512 * 1024);
              const firstLine = content.indexOf('\n');
              if (firstLine >= 0) content = content.slice(firstLine + 1);
              else if (/^[\uDC00-\uDFFF]/.test(content)) content = content.slice(1);
              truncated = true;
            }
            truncated ||= next.truncated;
            setEntry(storeContainerLogs(container.id, revision, {content, truncated}));
          }
          setConnection(next.state);
          if (next.state === 'error') setError(next.message || t('로그 연결이 끊어졌습니다. 다시 연결하세요.'));
        });
        if (disposed) { unlisten(); return; }
        await backend('container_logs_start', {id: container.id, streamId});
        if (disposed) await stop();
      } catch (failure) {
        if (!disposed) { setConnection('error'); setError(errorMessage(failure)); }
      }
    };
    void start();
    return () => { disposed = true; unlisten?.(); void stop(); };
  }, [active, container.id, container.state, revision, restart]);
  const content = entry?.data.content ?? '';
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const visible = useMemo(() => deferredSearch ? content.split('\n').filter(line => line.toLowerCase().includes(deferredSearch)).join('\n') : content, [content, deferredSearch]);
  useEffect(() => { if (autoScroll && logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight; }, [visible, autoScroll]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(visible); setCopyOperation({tone: 'success', message: t('표시된 로그를 복사했습니다.')}); }
    catch (failure) { setCopyOperation({tone: 'danger', message: errorMessage(failure)}); }
  };
  return <><div className="log-controls"><SearchInput value={search} onChange={setSearch} placeholder={t('로그 검색…')} /><label className="checkbox-control"><input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} />{t('자동 스크롤')}</label><button className="button small" onClick={() => setRestart(value => value + 1)} aria-label={t('로그 다시 연결')}><Icon name="refresh" size={14} /></button><button className="button small subtle" disabled={!visible} onClick={() => void copy()}><Icon name="copy" size={14} />{t('복사')}</button></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {copyOperation && <OperationNotice operation={copyOperation} onDismiss={() => setCopyOperation(null)} />}
    <pre className="logs" ref={logsRef} tabIndex={0} aria-label={t('컨테이너 로그')}>{visible || (connection === 'connecting' && !entry ? t('로그에 연결하는 중…') : error ? t('로그를 조회할 수 없습니다.') : search && content ? t('검색과 일치하는 로그가 없습니다.') : t('기록된 로그가 없습니다.'))}</pre>
    <div className="log-status"><span>{connection === 'connecting' ? t('연결 중…') : connection === 'streaming' ? t('새 로그 감지 중') : connection === 'closed' ? t('로그 수신 완료') : t('로그 연결 끊김')}{entry?.data.truncated ? ' · ' + t('최근 로그 · 일부 잘림') : ''}</span><span>{entry ? new Date(entry.readAt).toLocaleTimeString(getLocale()) : t('미수신')}</span></div>
  </>;
}
