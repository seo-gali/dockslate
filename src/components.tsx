import { useEffect, useRef, type ReactNode } from 'react';

export type IconName = 'overview' | 'containers' | 'images' | 'disk' | 'settings' | 'refresh' | 'search' | 'close' | 'arrow' | 'check' | 'warning' | 'copy' | 'play' | 'stop' | 'trash' | 'more' | 'download';

const paths: Record<IconName, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  containers: <><path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8" /></>,
  images: <><path d="m3 7 9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4" /></>,
  disk: <><path d="m5 4-3 12v4h20v-4L19 4zM2 16h20" /><path d="M16 18h.01M19 18h.01" /></>,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="16" cy="17" r="3" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.1 8a7.5 7.5 0 0 1 12.3-3L20 8M4 16l2.6 3A7.5 7.5 0 0 0 19 16" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  check: <path d="m5 12 4 4L19 6" />,
  warning: <><path d="M10.4 3.9 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.6 3.9a1.8 1.8 0 0 0-3.2 0Z" /><path d="M12 9v4M12 17h.01" /></>,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
  play: <path d="m8 4 12 8-12 8z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className="page-header"><div><h1>{title}</h1><p>{description}</p></div><div className="header-actions">{children}</div></div>;
}

export function StatusBadge({ tone = 'muted', children }: { tone?: 'success' | 'warning' | 'danger' | 'muted' | 'accent'; children: ReactNode }) {
  return <span className={`status-badge ${tone}`}><span className="status-dot" />{children}</span>;
}

export function StatePanel({ icon = 'containers', title, description, children, busy = false }: { icon?: IconName; title: string; description?: string; children?: ReactNode; busy?: boolean }) {
  return <div className="state-panel" aria-busy={busy}><div className={`state-icon ${busy ? 'working' : ''}`}><Icon name={busy ? 'refresh' : icon} size={28} /></div><h2>{title}</h2>{description && <p>{description}</p>}{children && <div className="state-actions">{children}</div>}</div>;
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="notice error" role="alert"><Icon name="warning" /><div><strong>조회 실패</strong><p>{message}</p></div>{onRetry && <button className="button subtle" onClick={onRetry}>다시 시도</button>}</div>;
}

export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="search-input"><Icon name="search" /><input type="search" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} />{value && <button type="button" className="icon-button" onClick={() => onChange('')} title="검색 지우기" aria-label="검색 지우기"><Icon name="close" size={15} /></button>}</label>;
}

export function RefreshButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return <button className="button" disabled={busy} onClick={onClick} title="모든 화면의 데이터를 함께 새로고침합니다"><Icon name="refresh" />{busy ? '전체 조회 중…' : '전체 새로고침'}</button>;
}

export function DetailPanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <aside className="detail-panel" aria-label={title}><header><h2 title={title}>{title}</h2><button className="icon-button" onClick={onClose} title="상세 패널 닫기" aria-label="상세 패널 닫기"><Icon name="close" /></button></header>{children}</aside>;
}

export function ConfirmDialog({ title, children, label, busy, ready = true, error, acknowledged, onAcknowledge, onCancel, onConfirm }: { title: string; children: ReactNode; label: string; busy: boolean; ready?: boolean; error: string | null; acknowledged: boolean; onAcknowledge: (value: boolean) => void; onCancel: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => previousFocus.current?.focus();
  }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
      if (event.key === 'Tab') {
        const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []);
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [busy, onCancel]);
  return <div className="modal-backdrop"><div className="confirm-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="confirm-title"><div className="dialog-heading"><span className="danger"><Icon name="warning" size={22} /></span><h2 id="confirm-title">{title}</h2></div><div className="dialog-content">{children}</div><label className="acknowledgement"><input type="checkbox" checked={acknowledged} disabled={busy || !ready} onChange={event => onAcknowledge(event.target.checked)} /><span>대상과 영향을 확인했으며 이 작업을 승인합니다.</span></label>{error && <div className="dialog-error" role="alert">{error}</div>}<footer><button ref={cancelRef} className="button" disabled={busy} onClick={onCancel}>취소</button><button className="button danger-button" disabled={busy || !ready || !acknowledged} onClick={onConfirm}>{busy ? '처리 중…' : !ready ? '검사 대기' : label}</button></footer></div></div>;
}

export function formatBytes(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return '미확인';
  const absolute = Math.abs(bytes);
  if (absolute < 1000) return `${bytes.toLocaleString()} B`;
  const index = Math.min(Math.floor(Math.log(absolute) / Math.log(1000)), 4);
  return `${(bytes / 1000 ** index).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KB', 'MB', 'GB', 'TB'][index]}`;
}

export function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
  return String(error);
}
