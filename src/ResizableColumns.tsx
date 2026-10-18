import { useLayoutEffect, useMemo, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefCallback } from 'react';
import './resizable-columns.css';

export type ResizableColumn = {
  id: string;
  width: number;
  minWidth: number;
  maxWidth: number;
};

type Options = { storageKey: string; columns: readonly ResizableColumn[] };
type Drag = { index: number; pointerId: number; startX: number; widths: number[]; element: HTMLSpanElement };

export type ResizableColumnsController = ReturnType<typeof createController>;

function createController({ storageKey, columns }: Options) {
  const specs = columns.map(column => {
    const minWidth = Math.max(36, Math.round(column.minWidth));
    const maxWidth = Math.max(minWidth, Math.round(column.maxWidth));
    return { ...column, minWidth, maxWidth, width: Math.max(minWidth, Math.min(maxWidth, Math.round(column.width))) };
  });
  const bounded = (index: number, width: number) => Math.max(specs[index].minWidth, Math.min(specs[index].maxWidth, Math.round(width)));
  let widths = specs.map(column => column.width);
  let restored = false;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (saved && typeof saved === 'object' && 'version' in saved && saved.version === 1 && 'widths' in saved && saved.widths && typeof saved.widths === 'object') {
      const values = saved.widths as Record<string, unknown>;
      widths = specs.map((column, index) => {
        const width = values[column.id];
        if (typeof width !== 'number' || !Number.isFinite(width)) return column.width;
        restored = true;
        return bounded(index, width);
      });
    }
  } catch { /* Optional local preference */ }

  let table: HTMLTableElement | null = null;
  let drag: Drag | null = null;
  let frame: number | null = null;
  let pending: number[] | null = null;
  let observer: ResizeObserver | null = null;
  let fitted = restored;
  const listeners = new Set<() => void>();
  const indexOf = (id: string) => {
    const index = specs.findIndex(column => column.id === id);
    if (index < 0) throw new Error(`Unknown resizable column: ${id}`);
    return index;
  };
  const paint = () => {
    if (!table) return;
    widths.forEach((width, index) => table!.style.setProperty(`--resizable-column-${index}`, `${width}px`));
    table.style.setProperty('--resizable-table-width', `${widths.reduce((sum, width) => sum + width, 0)}px`);
  };
  const apply = (next: number[]) => {
    if (next.every((width, index) => width === widths[index])) return;
    widths = next;
    paint();
    listeners.forEach(listener => listener());
  };
  const persist = () => {
    try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, widths: Object.fromEntries(specs.map((column, index) => [column.id, widths[index]])) })); }
    catch { /* Optional local preference */ }
  };
  const cancelFrame = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    pending = null;
  };
  const fit = () => {
    const available = table?.parentElement?.clientWidth ?? 0;
    if (fitted || available === 0) return;
    fitted = true;
    observer?.disconnect();
    observer = null;
    const next = [...widths];
    let remaining = Math.max(0, available - next.reduce((sum, width) => sum + width, 0));
    while (remaining > 0) {
      const growable = specs.map((column, index) => index).filter(index => next[index] < specs[index].maxWidth);
      if (!growable.length) break;
      const share = Math.max(1, Math.floor(remaining / growable.length));
      for (const index of growable) {
        const growth = Math.min(share, remaining, specs[index].maxWidth - next[index]);
        next[index] += growth;
        remaining -= growth;
      }
    }
    apply(next);
  };
  const activate = () => {
    paint();
    fit();
    if (!fitted && table?.parentElement && typeof ResizeObserver !== 'undefined') {
      observer?.disconnect();
      observer = new ResizeObserver(fit);
      observer.observe(table.parentElement);
    }
  };
  const finish = (save: boolean) => {
    if (!drag) return;
    const current = drag;
    drag = null;
    const next = pending;
    cancelFrame();
    if (!save) apply(current.widths);
    else if (next) apply(next);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', escape);
    window.removeEventListener('blur', cancel);
    current.element.removeEventListener('lostpointercapture', cancel);
    current.element.classList.remove('is-resizing');
    document.documentElement.classList.remove('column-resizing');
    if (current.element.hasPointerCapture?.(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    if (save) persist();
  };
  const move = (event: globalThis.PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    pending = [...drag.widths];
    pending[drag.index] = bounded(drag.index, drag.widths[drag.index] + event.clientX - drag.startX);
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const next = pending;
      pending = null;
      if (next) apply(next);
    });
  };
  const up = (event: globalThis.PointerEvent) => { if (event.pointerId === drag?.pointerId) finish(true); };
  const cancel = (event: Event) => {
    if ('pointerId' in event && event.pointerId !== drag?.pointerId) return;
    finish(false);
  };
  const escape = (event: globalThis.KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    finish(false);
  };
  const reset = (id: string) => {
    finish(false);
    const index = indexOf(id), next = [...widths];
    next[index] = specs[index].width;
    apply(next);
    persist();
  };
  return {
    columns: specs,
    tableRef: ((node: HTMLTableElement | null) => {
      if (table !== node) finish(false);
      observer?.disconnect();
      observer = null;
      table = node;
      if (table) activate();
    }) satisfies RefCallback<HTMLTableElement>,
    activate,
    dispose: () => { finish(false); cancelFrame(); observer?.disconnect(); observer = null; },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getWidth: (id: string) => widths[indexOf(id)],
    getColumn: (id: string) => specs[indexOf(id)],
    reset,
    pointerDown: (id: string, event: PointerEvent<HTMLSpanElement>) => {
      if (event.button !== 0 || !event.isPrimary || !table) return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
      const element = event.currentTarget;
      element.focus({ preventScroll: true });
      drag = { index: indexOf(id), pointerId: event.pointerId, startX: event.clientX, widths: [...widths], element };
      element.classList.add('is-resizing');
      document.documentElement.classList.add('column-resizing');
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('keydown', escape);
      window.addEventListener('blur', cancel);
      element.addEventListener('lostpointercapture', cancel);
      try { element.setPointerCapture(event.pointerId); } catch { /* Window listeners retain drag control */ }
    },
    keyDown: (id: string, event: KeyboardEvent<HTMLSpanElement>) => {
      const index = indexOf(id), step = event.shiftKey ? 50 : 10;
      let width: number;
      switch (event.key) {
        case 'ArrowLeft': width = widths[index] - step; break;
        case 'ArrowRight': width = widths[index] + step; break;
        case 'Home': width = specs[index].minWidth; break;
        case 'End': width = specs[index].maxWidth; break;
        case 'Enter':
          event.preventDefault(); event.stopPropagation(); reset(id); return;
        default: return;
      }
      event.preventDefault();
      event.stopPropagation();
      finish(false);
      const next = [...widths];
      next[index] = bounded(index, width);
      apply(next);
      persist();
    },
  };
}

export function useResizableColumns(options: Options): ResizableColumnsController {
  const signature = JSON.stringify(options.columns);
  const controller = useMemo(() => createController(options), [options.storageKey, signature]);
  useLayoutEffect(() => { controller.activate(); return controller.dispose; }, [controller]);
  return controller;
}

export function ResizableColumnGroup({ controller }: { controller: ResizableColumnsController }) {
  return <colgroup>{controller.columns.map((column, index) => <col key={column.id} style={{ width: `var(--resizable-column-${index}, ${column.width}px)` } as CSSProperties} />)}</colgroup>;
}

export function ColumnResizeHandle({ controller, column, label, title }: { controller: ResizableColumnsController; column: string; label: string; title?: string }) {
  const width = useSyncExternalStore(controller.subscribe, () => controller.getWidth(column), () => controller.getWidth(column));
  const spec = controller.getColumn(column);
  return <span className="column-resize-handle" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={label} aria-valuenow={width} aria-valuemin={spec.minWidth} aria-valuemax={spec.maxWidth} title={title ?? label} onPointerDown={event => controller.pointerDown(column, event)} onKeyDown={event => controller.keyDown(column, event)} onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); controller.reset(column); }} />;
}
