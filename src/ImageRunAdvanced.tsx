import { useRef, useState } from 'react';
import { backend, refreshDashboardAfterMutation, useBackendQuery } from './api';
import { Icon, errorMessage } from './components';
import { t } from "./i18n";


export interface RunOptions {
  env?: string[]; command?: string[]; entrypoint?: string[]; workingDir?: string;
  restartPolicy?: string; networkId?: string | null; memoryBytes?: number | null; nanoCpus?: number | null;
  mounts?: { name: string; target: string; readOnly: boolean }[];
}
interface Network { id: string; name: string; driver: string; scope: string; internal: boolean; builtin: boolean }
const lines = (value: string) => value.split(/\r?\n/).filter(line => line.trim().length > 0);
const supportedNetwork = (network: Network) => network.scope === 'local' && (network.driver === 'bridge' || (network.driver === 'null' && network.name === 'none'));

export function ImageRunAdvanced({ options, onChange, disabled, onBusy, onNetworkNone }: { options: RunOptions; onChange: (options: RunOptions) => void; disabled: boolean; onBusy: (busy: boolean) => void; onNetworkNone: (none: boolean) => void }) {
  const volumes = useBackendQuery<{ name: string; driver: string; fileSupported: boolean }[]>('volumes_list');
  const networks = useBackendQuery<Network[]>('networks_list');
  const [envText, setEnvText] = useState(options.env?.join('\n') ?? '');
  const [commandText, setCommandText] = useState(options.command?.join('\n') ?? '');
  const [entrypointText, setEntrypointText] = useState(options.entrypoint?.join('\n') ?? '');
  const [creating, setCreating] = useState(false);
  const [createKind, setCreateKind] = useState<'network' | 'volume' | null>(null);
  const [networkName, setNetworkName] = useState('');
  const [volumeName, setVolumeName] = useState('');
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const change = (value: Partial<RunOptions>) => onChange({ ...options, ...value });
  const mount = (name: string) => change({ mounts: name ? [{ name, target: options.mounts?.[0]?.target || '/data', readOnly: options.mounts?.[0]?.readOnly ?? false }] : [] });
  const create = async (kind: 'network' | 'volume') => {
    const requestedName = (kind === 'network' ? networkName : volumeName).trim();
    if (inFlight.current || disabled || !requestedName) return;
    inFlight.current = true; setCreating(true); onBusy(true); setError(null);
    try {
      if (kind === 'network') {
        const result = await backend<{ id: string; name: string }>('network_create', { name: requestedName, internal });
        change({ networkId: result.id }); onNetworkNone(false);
        setNetworkName(''); setInternal(false);
      } else {
        const result = await backend<{ name: string }>('volume_create', { name: requestedName });
        mount(result.name); setVolumeName('');
      }
      setCreateKind(null);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { await refreshDashboardAfterMutation(); inFlight.current = false; setCreating(false); onBusy(false); }
  };
  const busy = disabled || creating;
  return <details className="run-advanced">
    <summary>{t("더보기") + " "}<span className="muted">{t("네트워크 · 볼륨 · 환경 변수 · 실행 설정")}</span></summary>
    <div className="field"><label htmlFor="run-network">{t("네트워크")}</label><div className="toolbar" style={{ marginBottom: 0 }}><select id="run-network" className="text-input" value={options.networkId ?? ''} disabled={busy || networks.loading} onChange={event => { change({ networkId: event.target.value || null }); onNetworkNone(networks.data?.find(network => network.id === event.target.value)?.name === 'none'); }}><option value="">{t("기본 (bridge)")}</option>{networks.data?.filter(network => network.name !== 'bridge').map(network => <option key={network.id} value={network.id} disabled={!supportedNetwork(network)}>{network.name}{!supportedNetwork(network) ? t(" · 실행 연결 미지원") : network.name === 'none' ? t(" · 연결 안 함") : network.internal ? t(" · 내부 전용") : ''}</option>)}</select><button className="button small" type="button" disabled={busy || networks.loading} onClick={() => void networks.reload()} aria-label={t("네트워크 목록 새로고침")}><Icon name="refresh" size={14} /></button><button className="button small" type="button" disabled={busy} aria-expanded={createKind === 'network'} onClick={() => setCreateKind(value => value === 'network' ? null : 'network')}>{t("네트워크 만들기")}</button></div>{networks.error && <p className="danger" role="alert">{networks.error}</p>}</div>
    {createKind === 'network' && <div className="run-network-create"><div className="toolbar" style={{ alignItems: 'flex-end', marginBottom: 0 }}><div className="field"><label htmlFor="run-network-name">{t("새 네트워크 이름")}</label><input id="run-network-name" className="text-input" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void create('network'); } }} value={networkName} onChange={event => setNetworkName(event.target.value)} disabled={busy} maxLength={63} placeholder={t("예: app-network")} spellCheck={false} /></div><button className="button small" type="button" disabled={busy || !networkName.trim()} onClick={() => void create('network')}>{creating ? t("생성 중…") : t("만들고 선택")}</button></div><label className="checkbox-control"><input id="run-network-internal" type="checkbox" checked={internal} onChange={event => setInternal(event.target.checked)} disabled={busy} />{t("외부 통신 차단 (Internal)")}</label></div>}
    <div className="field"><label htmlFor="run-volume">{t("볼륨")}</label><div className="toolbar" style={{ marginBottom: 0 }}><select id="run-volume" className="text-input" value={options.mounts?.[0]?.name ?? ''} disabled={busy || volumes.loading} onChange={event => mount(event.target.value)}><option value="">{t("연결 안 함")}</option>{volumes.data?.filter(volume => volume.fileSupported).map(volume => <option value={volume.name} key={volume.name}>{volume.name}</option>)}</select><button className="button small" type="button" disabled={busy || volumes.loading} onClick={() => void volumes.reload()} aria-label={t("볼륨 목록 새로고침")}><Icon name="refresh" size={14} /></button><button className="button small" type="button" disabled={busy} aria-expanded={createKind === 'volume'} onClick={() => setCreateKind(value => value === 'volume' ? null : 'volume')}>{t("볼륨 만들기")}</button></div>{volumes.error && <p className="danger" role="alert">{volumes.error}</p>}</div>
    {createKind === 'volume' && <div className="run-network-create"><div className="toolbar" style={{ alignItems: 'flex-end', marginBottom: 0 }}><div className="field"><label htmlFor="run-volume-name">{t("새 볼륨 이름")}</label><input id="run-volume-name" className="text-input" value={volumeName} onChange={event => setVolumeName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void create('volume'); } }} disabled={busy} maxLength={128} placeholder={t("예: app-data")} spellCheck={false} /></div><button className="button small" type="button" disabled={busy || !volumeName.trim()} onClick={() => void create('volume')}>{creating ? t("생성 중…") : t("만들고 선택")}</button></div></div>}
    <div className="toolbar"><div className="field"><label htmlFor="run-volume-target">{t("볼륨 연결 경로")}</label><input id="run-volume-target" className="text-input mono" value={options.mounts?.[0]?.target ?? ''} placeholder="/data" disabled={busy || !options.mounts?.[0]} required={!!options.mounts?.[0]} onChange={event => { if (options.mounts?.[0]) change({ mounts: [{ ...options.mounts[0], target: event.target.value }] }); }} /></div><label className="checkbox-control" style={{ marginTop: 24 }}><input id="run-volume-readonly" type="checkbox" disabled={busy || !options.mounts?.[0]} checked={options.mounts?.[0]?.readOnly ?? false} onChange={event => { if (options.mounts?.[0]) change({ mounts: [{ ...options.mounts[0], readOnly: event.target.checked }] }); }} />{t("읽기 전용")}</label></div>
    {error && <div className="dialog-error" role="alert">{error}</div>}
    <div className="field"><label htmlFor="run-env">{t("환경 변수 · 한 줄에 KEY=value")}</label><textarea id="run-env" className="text-input mono" rows={3} maxLength={32768} value={envText} disabled={busy} onChange={event => { setEnvText(event.target.value); change({ env: lines(event.target.value) }); }} placeholder={'NODE_ENV=production\nPORT=3000'} spellCheck={false} /></div>
    <div className="toolbar"><div className="field"><label htmlFor="run-restart">{t("재시작 정책")}</label><select id="run-restart" className="text-input" value={options.restartPolicy ?? 'no'} disabled={busy} onChange={event => change({ restartPolicy: event.target.value })}><option value="no">{t("재시작 안 함")}</option><option value="on-failure">{t("오류 시 재시작")}</option><option value="unless-stopped">{t("중지할 때까지")}</option><option value="always">{t("항상")}</option></select></div><div className="field"><label htmlFor="run-memory">{t("메모리 · MB")}</label><input id="run-memory" className="text-input" type="number" min="16" max="1000000" step="1" value={options.memoryBytes == null ? '' : options.memoryBytes / 1_000_000} disabled={busy} onChange={event => change({ memoryBytes: event.target.value ? Number(event.target.value) * 1_000_000 : null })} placeholder={t("제한 없음")} /></div><div className="field"><label htmlFor="run-cpus">{t("CPU · 코어")}</label><input id="run-cpus" className="text-input" type="number" min="0.1" max="128" step="0.1" value={options.nanoCpus == null ? '' : options.nanoCpus / 1_000_000_000} disabled={busy} onChange={event => change({ nanoCpus: event.target.value ? Math.round(Number(event.target.value) * 1_000_000_000) : null })} placeholder={t("제한 없음")} /></div></div>
    <div className="field"><label htmlFor="run-workdir">{t("작업 경로")}</label><input id="run-workdir" className="text-input mono" value={options.workingDir ?? ''} disabled={busy} onChange={event => change({ workingDir: event.target.value })} placeholder={t("이미지 기본값 · 예: /app")} maxLength={4096} spellCheck={false} /></div>
    <div className="toolbar"><div className="field"><label htmlFor="run-command">{t("명령 (CMD) · 인수별 줄바꿈")}</label><textarea id="run-command" className="text-input mono" rows={3} value={commandText} disabled={busy} onChange={event => { setCommandText(event.target.value); change({ command: lines(event.target.value) }); }} maxLength={16384} placeholder={t("이미지 기본값\nnode\nserver.js")} spellCheck={false} /></div><div className="field"><label htmlFor="run-entrypoint">{t("ENTRYPOINT · 인수별 줄바꿈")}</label><textarea id="run-entrypoint" className="text-input mono" rows={3} value={entrypointText} disabled={busy} onChange={event => { setEntrypointText(event.target.value); change({ entrypoint: lines(event.target.value) }); }} maxLength={16384} placeholder={t("이미지 기본값")} spellCheck={false} /></div></div>
  </details>;
}
