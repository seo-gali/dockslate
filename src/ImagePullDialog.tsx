import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon, formatBytes } from './components';
import { t } from './i18n';
import './image-pull.css';

export interface PullProgress {
  requestId: string;
  reference: string;
  phase: 'connecting' | 'downloading' | 'verifying' | 'completed' | 'failed';
  status: string;
  layers: { id: string; status: string; current: number | null; total: number | null }[];
  receivedBytes: number;
  totalBytes: number | null;
  error?: string | null;
}

export default function ImagePullDialog({ progress, active, onClose }: { progress: PullProgress; active: boolean; onClose: () => void }) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const callback = useRef(onClose); callback.current = onClose;
  const done = progress.phase === 'completed' || progress.phase === 'failed';
  const doneRef = useRef(done); doneRef.current = done;
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (doneRef.current) callback.current(); }
      if (event.key !== 'Tab') return;
      const controls = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')];
      if (!controls.length) { event.preventDefault(); return; }
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); if (previous?.isConnected && !previous.closest('[hidden]')) previous.focus(); };
  }, [active]);
  useEffect(() => { if (done && active) closeButton.current?.focus(); }, [done, active]);
  if (!active) return null;
  const failed = progress.phase === 'failed';
  const title = failed ? t('이미지 받기에 실패했습니다.') : done ? t('이미지 받기가 완료되었습니다.') : t('이미지 받는 중');
  return createPortal(<div className="modal-backdrop"><div className="confirm-dialog image-pull-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <div className="dialog-heading"><span className={failed ? 'danger' : done ? 'success' : 'accent'}><Icon name={failed ? 'warning' : done ? 'check' : 'download'} size={22} /></span><h2 id={titleId}>{title}</h2></div>
    <div className="dialog-content">
      <div className="dialog-target">{progress.reference}</div>
      {!done && <><progress className="pull-overall-progress" aria-label={t('이미지 받기 진행 상태')} /><p role="status">{progress.phase === 'connecting' ? t('레지스트리에 연결하는 중…') : progress.phase === 'verifying' ? t('이미지를 확인하는 중…') : t('레이어를 내려받는 중…')}</p></>}
      {progress.receivedBytes > 0 && <p className="pull-byte-count">{t('다운로드')}: {formatBytes(progress.receivedBytes)}{progress.totalBytes !== null ? ` / ${formatBytes(progress.totalBytes)}` : ''}</p>}
      {failed && <p className="danger selectable" role="alert">{progress.error || progress.status}</p>}
      {progress.layers.length > 0 && <div className="pull-layers" aria-label={t('이미지 레이어 진행 상태')}>{progress.layers.slice(0, 64).map(layer => <div className="pull-layer" key={layer.id}>
        <div><span className="mono">{layer.id}</span><span>{t(layer.status)}</span></div>
        {layer.total !== null && layer.total > 0 && layer.current !== null && <progress max={layer.total} value={Math.min(layer.current, layer.total)} aria-label={layer.id + ' ' + t(layer.status)} />}
      </div>)}</div>}
    </div>
    <footer><button ref={closeButton} type="button" className="button primary" disabled={!done} onClick={onClose}>{done ? t('닫기') : t('이미지 받는 중…')}</button></footer>
  </div></div>, document.body);
}
