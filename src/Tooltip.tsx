import { useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const show = () => {
    const bounds = anchor.current?.getBoundingClientRect();
    if (bounds) setPosition({ left: Math.max(12, Math.min(bounds.right - 300, window.innerWidth - 312)), top: Math.max(12, bounds.top - 10) });
  };
  return <span className="tooltip-anchor" ref={anchor} tabIndex={0} aria-describedby={position ? id : undefined} onMouseEnter={show} onMouseLeave={() => setPosition(null)} onFocus={show} onBlur={() => setPosition(null)} onKeyDown={event => { if (event.key === 'Escape') setPosition(null); }}>{children}{position && createPortal(<span id={id} role="tooltip" className="floating-tooltip" style={{ left: position.left, top: position.top }}>{text}</span>, document.body)}</span>;
}
