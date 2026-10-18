import { useEffect, useRef, useState } from 'react';
import { backend, refreshDashboardAfterMutation, type DockerImage } from './api';
import { Icon, errorMessage } from './components';
import { ImageRunAdvanced, type RunOptions } from './ImageRunAdvanced';
import RunCommandDialog from './RunCommandDialog';
import { runCommand } from './runCommand';
import { t } from "./i18n";
import { readMetadata } from './metadataCache';


interface Details { id: string; tags: string[]; exposedPorts: string[]; entrypoint: string[]; command: string[] }
export interface RunResult { id: string; name: string; state: string; started: boolean; message: string }

export function ImageRun({ image, blocked, onClose, onCreated, onBusy }: { image: DockerImage; blocked: boolean; onClose: () => void; onCreated: (result: RunResult) => void; onBusy: (busy: boolean) => void }) {
  const [details, setDetails] = useState<Details | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [containerPort, setContainerPort] = useState('');
  const [hostPort, setHostPort] = useState('');
  const [protocol, setProtocol] = useState('tcp');
  const [running, setRunning] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [options, setOptions] = useState<RunOptions>({});
  const [networkNone, setNetworkNone] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const inFlight = useRef(false);
  const section = useRef<HTMLElement>(null);
  const read = async () => {
    setLoading(true); setError(null);
    try {
      const result = await readMetadata<Details>('image_details', image.id, 0);
      setDetails(result);
      const first = result.exposedPorts[0]?.split('/');
      if (first) { setContainerPort(first[0]); setProtocol(first[1] ?? 'tcp'); }
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void read(); section.current?.scrollIntoView({ block: 'nearest' }); }, [image.id]);
  const run = async () => {
    if (inFlight.current || blocked || loading || settingsBusy || !details) return;
    inFlight.current = true; setRunning(true); onBusy(true); setError(null);
    try {
      const result = await backend<RunResult>('container_run', { imageId: image.id, name: name.trim(), ports: containerPort ? [{ containerPort: Number(containerPort), hostPort: hostPort ? Number(hostPort) : null, protocol }] : [], options });
      await refreshDashboardAfterMutation();
      onCreated(result);
    } catch (failure) {
      setError(errorMessage(failure));
      await refreshDashboardAfterMutation();
    } finally { inFlight.current = false; setRunning(false); onBusy(false); }
  };
  return <section className="panel image-run-panel" aria-label={t("컨테이너 실행")} ref={section}>
    <div className="section-heading"><h2 style={{ marginBottom: 0 }}>{t("컨테이너 실행")}</h2><button type="button" className="icon-button" disabled={running || settingsBusy} onClick={onClose} aria-label={t("실행 설정 닫기")}><Icon name="close" /></button></div>
    <p className="mono" style={{ marginBottom: 14 }}>{image.tags[0] ?? image.id}</p>
    <form onSubmit={event => { event.preventDefault(); void run(); }}>
      <div className="field" style={{ marginBottom: 14 }}><label htmlFor="run-name">{t("컨테이너 이름 · 비워두면 자동 생성")}</label><input id="run-name" className="text-input" value={name} maxLength={128} disabled={running || settingsBusy || blocked} onChange={event => setName(event.target.value)} placeholder={t("예: my-web")} spellCheck={false} /></div>
      <div className="toolbar"><div className="field"><label htmlFor="run-container-port">{t("컨테이너 포트 · 선택")}</label><input id="run-container-port" className="text-input" type="number" min="1" max="65535" value={containerPort} disabled={running || settingsBusy || blocked || networkNone} onChange={event => setContainerPort(event.target.value)} placeholder={t("예: 80")} /></div><div className="field"><label htmlFor="run-host-port">{t("내 PC 포트 · 비워두면 자동 할당")}</label><input id="run-host-port" className="text-input" type="number" min="1" max="65535" value={hostPort} disabled={running || settingsBusy || blocked || networkNone || !containerPort} onChange={event => setHostPort(event.target.value)} placeholder={t("예: 8080")} /></div><div className="field" style={{ flex: '0 0 90px' }}><label htmlFor="run-protocol">{t("프로토콜")}</label><select id="run-protocol" className="text-input" value={protocol} disabled={running || settingsBusy || blocked} onChange={event => setProtocol(event.target.value)}><option value="tcp">TCP</option><option value="udp">UDP</option></select></div></div>
      {loading && <p className="usage-note" role="status">{t("이미지 실행 정보를 확인하고 있습니다.")}</p>}
      {error && <div className="dialog-error" role="alert">{error}{!details && <button type="button" className="button small" disabled={loading || running} onClick={() => void read()}>{t("다시 확인")}</button>}</div>}
      <ImageRunAdvanced options={options} onChange={setOptions} disabled={running || blocked || loading} onBusy={value => { setSettingsBusy(value); onBusy(value); }} onNetworkNone={value => { setNetworkNone(value); if (value) { setContainerPort(''); setHostPort(''); } }} />
      <div className="toolbar" style={{ marginTop: 14, marginBottom: 0 }}><button className="button" type="button" disabled={running || settingsBusy || blocked || loading || !details} onClick={event => { if (event.currentTarget.form?.reportValidity()) setCommandOpen(true); }}>{t("실행 명령어 확인")}</button><button className="button primary" disabled={running || settingsBusy || blocked || loading || !details} type="submit"><Icon name="play" size={16} />{running ? t("컨테이너 생성 중…") : t("컨테이너 생성 및 실행")}</button></div>
    </form>
    {commandOpen && <RunCommandDialog command={runCommand({ imageId: image.id, name, containerPort, hostPort, protocol, options, networkNone })} dockerCommand={runCommand({ imageId: image.id, name, containerPort, hostPort, protocol, options, networkNone }, 'docker')} onClose={() => setCommandOpen(false)} />}
  </section>;
}
