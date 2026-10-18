import { useEffect, useId, useRef, useState } from 'react';
import { Icon, errorMessage } from './components';
import { t } from "./i18n";


export default function RunCommandDialog({ command: powershell, dockerCommand, onClose }: { command: string; dockerCommand: string; onClose: () => void }) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const callback = useRef(onClose);
  callback.current = onClose;
  const [tab, setTab] = useState<'docker' | 'powershell'>('docker');
  const command = tab === 'docker' ? dockerCommand : powershell;
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); callback.current(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea') ?? []);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', keydown);
    return () => { window.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  const copy = async () => {
    setError(null);
    try { await navigator.clipboard.writeText(command); setCopied(true); }
    catch (failure) { setError(`명령어 복사 실패: ${errorMessage(failure)}`); }
  };
  return <div className="modal-backdrop"><div ref={dialog} className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ width: 840 }}><div className="dialog-heading"><h2 id={titleId}>{t("실행 명령어 확인")}</h2><button ref={close} className="icon-button" type="button" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label={t("명령어 확인 닫기")}><Icon name="close" /></button></div><div className="dialog-content"><div className="page-tabs" role="tablist" aria-label={t('명령어 형식')}><button role="tab" aria-selected={tab === 'docker'} className={tab === 'docker' ? 'active' : ''} onClick={() => { setTab('docker'); setCopied(false); }}>Docker (WSL)</button><button role="tab" aria-selected={tab === 'powershell'} className={tab === 'powershell' ? 'active' : ''} onClick={() => { setTab('powershell'); setCopied(false); }}>PowerShell</button></div><p>{tab === 'docker' ? t('DockSlate WSL 내부에서 실행하는 Docker 명령어입니다.') : t("현재 설정에 해당하는 PowerShell 7.3 이상 명령어입니다.")}</p><textarea className="text-input mono selectable" style={{ width: '100%', minHeight: 300, resize: 'vertical', lineHeight: 1.65, marginTop: 12 }} rows={17} value={command} readOnly aria-label={tab === 'docker' ? t('Docker 실행 명령어') : t("PowerShell 실행 명령어")} spellCheck={false} />{error && <p className="danger" role="alert">{error}</p>}{copied && <p role="status">{t("명령어를 복사했습니다.")}</p>}</div><footer><button className="button" type="button" onClick={onClose}>{t("닫기")}</button><button className="button primary" type="button" onClick={() => void copy()}><Icon name="copy" size={15} />{copied ? t("복사됨") : t("명령어 복사")}</button></footer></div></div>;
}
