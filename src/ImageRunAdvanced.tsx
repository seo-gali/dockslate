import { useRef, useState } from 'react';
import { backend, useBackendQuery } from './api';
import { Icon, errorMessage } from './components';

export interface RunOptions {
  env?: string[]; command?: string[]; entrypoint?: string[]; workingDir?: string;
  restartPolicy?: string; networkId?: string | null; memoryBytes?: number | null; nanoCpus?: number | null;
  mounts?: { name: string; target: string; readOnly: boolean }[];
}
interface Network { id: string; name: string; driver: string; internal: boolean; builtin: boolean }
const lines = (value: string) => value.split(/\r?\n/).filter(line => line.trim().length > 0);

export function ImageRunAdvanced({ options, onChange, disabled, onBusy, onNetworkNone }: { options: RunOptions; onChange: (options: RunOptions) => void; disabled: boolean; onBusy: (busy: boolean) => void; onNetworkNone: (none: boolean) => void }) {
  const volumes = useBackendQuery<{ name: string; driver: string; fileSupported: boolean }[]>('volumes_list');
  const [envText, setEnvText] = useState(options.env?.join('\n') ?? '');
  const [commandText, setCommandText] = useState(options.command?.join('\n') ?? '');
  const [entrypointText, setEntrypointText] = useState(options.entrypoint?.join('\n') ?? '');
  const [networks, setNetworks] = useState<Network[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [networkName, setNetworkName] = useState('');
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(false);
  const started = useRef(false);
  const change = (value: Partial<RunOptions>) => onChange({ ...options, ...value });
  const load = async () => {
    if (reading.current) return;
    reading.current = true; setLoading(true); setError(null);
    try { setNetworks(await backend<Network[]>('networks_list')); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { reading.current = false; setLoading(false); }
  };
  const create = async () => {
    if (creating || disabled || !networkName.trim()) return;
    setCreating(true); onBusy(true); setError(null);
    try {
      const network = await backend<{ id: string; name: string }>('network_create', { name: networkName.trim(), internal });
      change({ networkId: network.id }); onNetworkNone(false);
      setShowCreate(false); setNetworkName(''); setInternal(false);
      await load();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setCreating(false); onBusy(false); }
  };
  const busy = disabled || creating;
  return <details className="run-advanced" onToggle={event => { if (event.currentTarget.open && !started.current) { started.current = true; void load(); } }}>
    <summary>더보기 <span className="muted">네트워크 · 볼륨 · 환경 변수 · 실행 설정</span></summary>
    <div className="field"><label htmlFor="run-network">Docker 네트워크</label><div className="toolbar"><select id="run-network" className="text-input" value={options.networkId ?? ''} disabled={busy || loading} onChange={event => { change({ networkId: event.target.value || null }); onNetworkNone(networks?.find(network => network.id === event.target.value)?.name === 'none'); }}><option value="">기본 네트워크 (bridge)</option>{networks?.filter(network => network.name !== 'bridge').map(network => <option key={network.id} value={network.id}>{network.name}{network.name === 'none' ? ' · 네트워크 사용 안 함' : network.internal ? ' · 내부 전용' : ''}</option>)}</select><button className="button small" type="button" disabled={busy || loading} onClick={() => void load()} aria-label="네트워크 목록 새로고침"><Icon name="refresh" size={14} />{loading ? '조회 중…' : '새로고침'}</button><button className="button small" type="button" disabled={busy} aria-expanded={showCreate} onClick={() => setShowCreate(value => !value)}>네트워크 만들기</button></div><p className="usage-note">같은 사용자 네트워크에 연결하면 컨테이너 이름으로 서로 통신할 수 있습니다.</p></div>
    {showCreate && <div className="run-network-create"><div className="field"><label htmlFor="run-network-name">새 bridge 네트워크 이름</label><input id="run-network-name" className="text-input" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void create(); } }} value={networkName} onChange={event => setNetworkName(event.target.value)} disabled={busy} maxLength={63} placeholder="예: my-app-network" spellCheck={false} /></div><label className="checkbox-control"><input id="run-network-internal" type="checkbox" checked={internal} onChange={event => setInternal(event.target.checked)} disabled={busy} />내부 전용 · 외부 인터넷 연결 차단</label><button className="button small" type="button" disabled={busy || !networkName.trim()} onClick={() => void create()}>{creating ? '생성 중…' : '네트워크 생성'}</button><p className="usage-note">전용 엔진에 네트워크를 만들고 선택합니다. 실행 설정을 닫아도 만든 네트워크는 유지됩니다.</p></div>}
    <div className="toolbar"><div className="field"><label htmlFor="run-volume">저장 볼륨 · 선택</label><select id="run-volume" className="text-input" value={options.mounts?.[0]?.name ?? ''} disabled={busy || volumes.loading} onChange={event => change({ mounts: event.target.value ? [{ name: event.target.value, target: options.mounts?.[0]?.target || '/data', readOnly: options.mounts?.[0]?.readOnly ?? false }] : [] })}><option value="">볼륨 연결 안 함</option>{volumes.data?.filter(volume => volume.fileSupported).map(volume => <option value={volume.name} key={volume.name}>{volume.name}</option>)}</select></div><div className="field"><label htmlFor="run-volume-target">컨테이너 내부 경로</label><input id="run-volume-target" className="text-input mono" value={options.mounts?.[0]?.target ?? ''} placeholder="예: /data" disabled={busy || !options.mounts?.[0]} required={!!options.mounts?.[0]} onChange={event => { if (options.mounts?.[0]) change({ mounts: [{ ...options.mounts[0], target: event.target.value }] }); }} /></div></div><label className="checkbox-control"><input id="run-volume-readonly" type="checkbox" disabled={busy || !options.mounts?.[0]} checked={options.mounts?.[0]?.readOnly ?? false} onChange={event => { if (options.mounts?.[0]) change({ mounts: [{ ...options.mounts[0], readOnly: event.target.checked }] }); }} />볼륨을 읽기 전용으로 연결</label><p className="usage-note">Volumes 메뉴에서 볼륨을 만들 수 있습니다. 컨테이너를 삭제해도 볼륨 데이터는 유지됩니다.</p>
    {error && <div className="dialog-error" role="alert">{error}</div>}
    <div className="field"><label htmlFor="run-env">환경 변수 · 한 줄에 KEY=value</label><textarea id="run-env" className="text-input mono" rows={3} maxLength={32768} value={envText} disabled={busy} onChange={event => { setEnvText(event.target.value); change({ env: lines(event.target.value) }); }} placeholder={'NODE_ENV=production\nPORT=3000'} spellCheck={false} /></div>
    <div className="toolbar"><div className="field"><label htmlFor="run-restart">재시작 정책</label><select id="run-restart" className="text-input" value={options.restartPolicy ?? 'no'} disabled={busy} onChange={event => change({ restartPolicy: event.target.value })}><option value="no">자동 재시작 안 함</option><option value="on-failure">오류로 종료되면 재시작</option><option value="unless-stopped">직접 중지할 때까지 재시작</option><option value="always">항상 재시작</option></select></div><div className="field"><label htmlFor="run-memory">메모리 제한 · MB</label><input id="run-memory" className="text-input" type="number" min="16" max="1000000" step="1" value={options.memoryBytes == null ? '' : options.memoryBytes / 1_000_000} disabled={busy} onChange={event => change({ memoryBytes: event.target.value ? Number(event.target.value) * 1_000_000 : null })} placeholder="제한 없음" /></div><div className="field"><label htmlFor="run-cpus">CPU 제한 · 코어</label><input id="run-cpus" className="text-input" type="number" min="0.1" max="128" step="0.1" value={options.nanoCpus == null ? '' : options.nanoCpus / 1_000_000_000} disabled={busy} onChange={event => change({ nanoCpus: event.target.value ? Math.round(Number(event.target.value) * 1_000_000_000) : null })} placeholder="제한 없음" /></div></div>
    <div className="field"><label htmlFor="run-workdir">작업 디렉터리 · 컨테이너 내부 경로</label><input id="run-workdir" className="text-input mono" value={options.workingDir ?? ''} disabled={busy} onChange={event => change({ workingDir: event.target.value })} placeholder="이미지 기본값 사용 · 예: /app" maxLength={4096} spellCheck={false} /></div>
    <div className="toolbar"><div className="field"><label htmlFor="run-command">명령 (CMD) · 한 줄에 인수 하나</label><textarea id="run-command" className="text-input mono" rows={3} value={commandText} disabled={busy} onChange={event => { setCommandText(event.target.value); change({ command: lines(event.target.value) }); }} maxLength={16384} placeholder={'이미지 기본값 사용\n예: node\nserver.js'} spellCheck={false} /></div><div className="field"><label htmlFor="run-entrypoint">시작 프로그램 (ENTRYPOINT) · 한 줄에 인수 하나</label><textarea id="run-entrypoint" className="text-input mono" rows={3} value={entrypointText} disabled={busy} onChange={event => { setEntrypointText(event.target.value); change({ entrypoint: lines(event.target.value) }); }} maxLength={16384} placeholder="이미지 기본값 사용" spellCheck={false} /></div></div>
  </details>;
}
