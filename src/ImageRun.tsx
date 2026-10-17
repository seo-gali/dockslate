import { useEffect, useRef, useState } from 'react';
import { backend, refreshDashboardAfterMutation, type DockerImage } from './api';
import { Icon, errorMessage } from './components';
import { ImageRunAdvanced, type RunOptions } from './ImageRunAdvanced';

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
  const inFlight = useRef(false);
  const section = useRef<HTMLElement>(null);
  const read = async () => {
    setLoading(true); setError(null);
    try {
      const result = await backend<Details>('image_details', { id: image.id });
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
  return <section className="panel image-run-panel" aria-label="컨테이너 실행" ref={section}>
    <div className="section-heading"><h2 style={{ marginBottom: 0 }}>컨테이너 실행</h2><button type="button" className="icon-button" disabled={running || settingsBusy} onClick={onClose} aria-label="실행 설정 닫기"><Icon name="close" /></button></div>
    <p className="mono" style={{ marginBottom: 14 }}>{image.tags[0] ?? image.id}</p>
    <form onSubmit={event => { event.preventDefault(); void run(); }}>
      <div className="field" style={{ marginBottom: 14 }}><label htmlFor="run-name">컨테이너 이름 · 비워두면 자동 생성</label><input id="run-name" className="text-input" value={name} maxLength={128} disabled={running || settingsBusy || blocked} onChange={event => setName(event.target.value)} placeholder="예: my-web" spellCheck={false} /></div>
      <div className="toolbar"><div className="field"><label htmlFor="run-container-port">컨테이너 포트 · 선택</label><input id="run-container-port" className="text-input" type="number" min="1" max="65535" value={containerPort} disabled={running || settingsBusy || blocked || networkNone} onChange={event => setContainerPort(event.target.value)} placeholder="예: 80" /></div><div className="field"><label htmlFor="run-host-port">내 PC 포트 · 비워두면 자동 할당</label><input id="run-host-port" className="text-input" type="number" min="1" max="65535" value={hostPort} disabled={running || settingsBusy || blocked || networkNone || !containerPort} onChange={event => setHostPort(event.target.value)} placeholder="예: 8080" /></div><div className="field" style={{ flex: '0 0 90px' }}><label htmlFor="run-protocol">프로토콜</label><select id="run-protocol" className="text-input" value={protocol} disabled={running || settingsBusy || blocked} onChange={event => setProtocol(event.target.value)}><option value="tcp">TCP</option><option value="udp">UDP</option></select></div></div>
      {loading && <p className="usage-note" role="status">이미지 실행 정보를 확인하고 있습니다.</p>}
      {details && <p className="usage-note">이미지에 설정된 기본 명령을 사용하며 더보기에서 바꿀 수 있습니다. 포트를 지정하면 이 PC의 localhost로 연결합니다. 명령이 끝나면 컨테이너도 중지됩니다.</p>}
      {error && <div className="dialog-error" role="alert">{error}{!details && <button type="button" className="button small" disabled={loading || running} onClick={() => void read()}>다시 확인</button>}</div>}
      <ImageRunAdvanced options={options} onChange={setOptions} disabled={running || blocked || loading} onBusy={value => { setSettingsBusy(value); onBusy(value); }} onNetworkNone={value => { setNetworkNone(value); if (value) { setContainerPort(''); setHostPort(''); } }} />
      {networkNone && <p className="usage-note">네트워크를 사용하지 않아 포트를 연결하지 않습니다.</p>}
      <button className="button primary" style={{ marginTop: 14 }} disabled={running || settingsBusy || blocked || loading || !details} type="submit"><Icon name="play" size={16} />{running ? '컨테이너 생성 중…' : '컨테이너 생성 및 실행'}</button>
    </form>
  </section>;
}
