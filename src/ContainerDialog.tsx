import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './components';
import { t } from "./i18n";


export function ContainerDialog({ title, active, onClose, children }: { title: string; active: boolean; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[aria-labelledby="confirm-title"]')) return;
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]') ?? [])].filter(element => element.getClientRects().length > 0);
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      if (previous?.isConnected && !previous.closest('[hidden]')) previous.focus();
    };
  }, [active]);
  return createPortal(<div className="container-modal-backdrop" hidden={!active} onPointerDown={event => { if (event.target === event.currentTarget && !document.querySelector('[aria-labelledby="confirm-title"]')) onClose(); }}><div ref={dialog} className="container-dialog detail-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}><header className="detail-heading"><h2 id={titleId}>{title}</h2><button ref={closeButton} className="icon-button" onClick={onClose} title={t("컨테이너 상세 닫기")} aria-label={t("컨테이너 상세 닫기")}><Icon name="close" /></button></header><div className="container-dialog-body">{children}</div></div></div>, document.body);
}
