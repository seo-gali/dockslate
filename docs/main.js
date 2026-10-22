const tabs = [...document.querySelectorAll('[role="tab"]')];
const selectTab = selected => {
  tabs.forEach(tab => {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
  });
};
document.querySelector('[role="tablist"]').hidden = false;
selectTab(tabs[0]);
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    selectTab(tabs[next]);
    tabs[next].focus();
  });
});
document.querySelectorAll('[data-copy-target]').forEach(button => {
  button.addEventListener('click', async () => {
    const status = document.getElementById('copy-status');
    try {
      await navigator.clipboard.writeText(document.getElementById(button.dataset.copyTarget).textContent.trim());
      status.textContent = button.getAttribute('aria-label') + ' 완료';
      const label = button.textContent;
      button.textContent = '복사됨';
      button.disabled = true;
      setTimeout(() => { button.textContent = label; button.disabled = false; }, 1800);
    } catch {
      status.textContent = '자동 복사를 사용할 수 없습니다. 표시된 명령어나 해시를 선택해 복사하세요.';
    }
  });
});
