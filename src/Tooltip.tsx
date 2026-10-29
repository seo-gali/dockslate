import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function TooltipLayer() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useEffect(() => {
    const enter = (event: Event) => setTarget(event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tooltip]') : null);
    const leave = (event: Event) => { const related = (event as MouseEvent).relatedTarget; if (!(related instanceof Element) || !related.closest('[data-tooltip]')) setTarget(null); };
    const close = () => setTarget(null);
    document.addEventListener('pointerover', enter);
    document.addEventListener('pointerout', leave);
    document.addEventListener('focusin', enter);
    document.addEventListener('focusout', close);
    document.addEventListener('keydown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerover', enter); document.removeEventListener('pointerout', leave); document.removeEventListener('focusin', enter); document.removeEventListener('focusout', close); document.removeEventListener('keydown', close); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, []);
  useLayoutEffect(() => {
    if (!target || !bubble.current) return;
    const bounds = target.getBoundingClientRect(), size = bubble.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(bounds.left, innerWidth - size.width - 8)), top: bounds.bottom + size.height + 8 < innerHeight ? bounds.bottom + 8 : Math.max(8, bounds.top - size.height - 8) });
  }, [target]);
  return target?.dataset.tooltip ? createPortal(<span ref={bubble} role="tooltip" className="action-tooltip" style={position}>{target.dataset.tooltip}</span>, document.body) : null;
}
