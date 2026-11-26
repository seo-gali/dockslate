import { backend } from './ipc/client';

export function installContextMenu() {
  document.addEventListener('contextmenu', event => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const input = event.target instanceof Element ? event.target.closest<HTMLInputElement | HTMLTextAreaElement>('input, textarea') : null;
    const content = event.target instanceof HTMLElement && event.target.closest<HTMLElement>('[contenteditable="true"]');
    if (!input && !content && !window.getSelection()?.toString()) return;
    if (input) input.focus({ preventScroll: true });
    void backend('desktop_edit_menu', { editable: !!content || !!input && !input.readOnly && !input.disabled }).catch(error => console.error('DockSlate edit menu:', error));
  });
}
