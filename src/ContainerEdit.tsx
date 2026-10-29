import { useEffect, useRef, useState } from 'react';
import { backend, refreshDashboardAfterMutation, useBackendQuery } from './api';
import { ContainerDialog } from './ContainerDialog';
import { ConfirmDialog, ErrorNotice, Icon, errorMessage } from './components';
import { t } from './i18n';

interface Port { containerPort: number; hostPort: number; protocol: string; hostIp: string }
interface Mount { name: string; target: string; readOnly: boolean }
interface Settings { id: string; name: string; ports: Port[]; mounts: Mount[]; networks: string[] }
interface Source { settings: Settings; state: string; recreateBlockedReason: string | null; fixedMounts: { kind: string; source: string; target: string; readOnly: boolean }[] }
interface Preview { token: string; expiresAt: number; before: Settings; after: Settings; recreate: boolean; wasRunning: boolean }
interface Result { id: string; name: string; message: string; retainedContainer?: string | null; savedImage?: string }
interface Network { id: string; name: string; driver: string; scope: string }
interface Volume { name: string; driver: string; scope: string }

export default function ContainerEdit({ id, active, blocked, onClose, onBusy, onComplete }: { id: string; active: boolean; blocked: boolean; onClose: () => void; onBusy: (busy: boolean) => void; onComplete: (result: Result) => void }) {
  const [source, setSource] = useState<Source | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [approved, setApproved] = useState(false);
  const request = useRef(false);
  const volumes = useBackendQuery<Volume[]>('volumes_list');
  const networks = useBackendQuery<Network[]>('networks_list');
  useEffect(() => { let live = true; void backend<Source>('container_edit_read', { id }).then(value => { if (live) { setSource(value); setSettings(value.settings); } }).catch(failure => { if (live) setError(errorMessage(failure)); }); return () => { live = false; }; }, [id]);
  useEffect(() => { onBusy(working); return () => onBusy(false); }, [working, onBusy]);
  const close = () => { if (!request.current) onClose(); };
  const change = (value: Partial<Settings>) => { setSettings(current => current ? { ...current, ...value } : current); setPreview(null); setApproved(false); };
  const inspect = async () => {
    if (!settings || request.current) return;
    request.current = true; setWorking(true); setError(null); setApproved(false);
    try { setPreview(await backend<Preview>('container_edit_preview', { request: settings })); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { request.current = false; setWorking(false); }
  };
  const execute = async () => {
    if (!preview || !approved || request.current) return;
    if (preview.expiresAt <= Date.now()) { setPreview(null); setApproved(false); setError(t('승인 정보가 만료되었습니다. 다시 검사하세요.')); return; }
    request.current = true; setWorking(true); setError(null);
    try { const result = await backend<Result>('container_edit_execute', { token: preview.token, approved: true }); await refreshDashboardAfterMutation(); onComplete(result); }
    catch (failure) { setPreview(null); setApproved(false); setError(errorMessage(failure)); await refreshDashboardAfterMutation(); }
    finally { request.current = false; setWorking(false); }
  };
  const networkNames = (value: Settings) => value.networks.map(id => networks.data?.find(network => network.id === id)?.name ?? id).join(', ') || t('없음');
  const ports = (value: Settings) => value.ports.map(port => `${port.hostIp}:${port.hostPort || t('자동')} → ${port.containerPort}/${port.protocol}`).join('\n') || t('없음');
  const mounts = (value: Settings) => value.mounts.map(mount => `${mount.name} → ${mount.target} (${mount.readOnly ? t('읽기 전용') : t('읽기·쓰기')})`).join('\n') || t('없음');
  return <><ContainerDialog title={t('컨테이너 수정')} active={active} onClose={close}><div className="detail-content container-edit">
    {error && <div className="notice error" role="alert"><Icon name="warning" /><p className="pre-wrap">{t(error)}</p></div>}
    {!settings || !source ? !error && <p role="status">{t('설정을 읽는 중…')}</p> : <form onSubmit={event => { event.preventDefault(); void inspect(); }}>
      <div className="field"><label htmlFor="edit-container-name">{t('이름')}</label><input id="edit-container-name" className="text-input" required pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,127}" maxLength={128} disabled={working} value={settings.name} onChange={event => change({ name: event.target.value })} /></div>
      {source.recreateBlockedReason && <p className="usage-note warning">{t(source.recreateBlockedReason)}</p>}
      <fieldset disabled={working || !!source.recreateBlockedReason}>
        <legend>{t('포트')}</legend><div className="edit-port-labels"><span>{t('호스트 IP')}</span><span>{t('내 PC 포트')}</span><span>{t('컨테이너 포트')}</span><span>{t('프로토콜')}</span></div>
        {settings.ports.map((port, index) => <div className="edit-port-row" key={index}>
          <input className="text-input mono" aria-label={t('호스트 IP')} required value={port.hostIp} onChange={event => change({ ports: settings.ports.map((item, offset) => offset === index ? { ...item, hostIp: event.target.value } : item) })} />
          <input className="text-input" type="number" min={0} max={65535} required aria-label={t('내 PC 포트')} value={port.hostPort} onChange={event => change({ ports: settings.ports.map((item, offset) => offset === index ? { ...item, hostPort: Number(event.target.value) } : item) })} />
          <input className="text-input" type="number" min={1} max={65535} required aria-label={t('컨테이너 포트')} value={port.containerPort} onChange={event => change({ ports: settings.ports.map((item, offset) => offset === index ? { ...item, containerPort: Number(event.target.value) } : item) })} />
          <select className="text-input" aria-label={t('프로토콜')} value={port.protocol} onChange={event => change({ ports: settings.ports.map((item, offset) => offset === index ? { ...item, protocol: event.target.value } : item) })}><option>tcp</option><option>udp</option></select>
          <button type="button" className="icon-button" aria-label={t('포트 연결 제거')} data-tooltip={t('포트 연결 제거')} onClick={() => change({ ports: settings.ports.filter((_, offset) => offset !== index) })}><Icon name="close" size={14} /></button>
        </div>)}<button type="button" className="button small" disabled={settings.ports.length >= 16} onClick={() => change({ ports: [...settings.ports, { hostIp: '127.0.0.1', hostPort: 0, containerPort: 80, protocol: 'tcp' }] })}>{t('포트 추가')}</button>
        {settings.ports.some(port => ['0.0.0.0', '::'].includes(port.hostIp)) && <p className="usage-note warning">{t('모든 주소에 공개하는 포트가 있습니다. 외부 PC에서도 접근할 수 있습니다.')}</p>}
      </fieldset>
      <fieldset disabled={working || !!source.recreateBlockedReason}><legend>{t('네트워크')}</legend>{networks.error && <ErrorNotice message={networks.error} onRetry={() => void networks.reload()} />}<div className="edit-networks">{networks.data?.filter(network => network.scope === 'local' && ['bridge', 'null'].includes(network.driver)).map(network => <label key={network.id} className="checkbox-control"><input type="checkbox" checked={settings.networks.includes(network.id)} onChange={event => change({ networks: event.target.checked ? [...settings.networks, network.id] : settings.networks.filter(id => id !== network.id) })} />{network.name}</label>)}</div></fieldset>
      <fieldset disabled={working || !!source.recreateBlockedReason}><legend>{t('볼륨')}</legend>{volumes.error && <ErrorNotice message={volumes.error} onRetry={() => void volumes.reload()} />}{settings.mounts.map((mount, index) => <div className="edit-mount-row" key={index}>
        <select className="text-input" aria-label={t('볼륨')} required value={mount.name} onChange={event => change({ mounts: settings.mounts.map((item, offset) => offset === index ? { ...item, name: event.target.value } : item) })}><option value="">{t('볼륨 선택')}</option>{volumes.data?.filter(volume => volume.driver === 'local').map(volume => <option key={volume.name} value={volume.name}>{volume.name}</option>)}</select>
        <input className="text-input mono" aria-label={t('컨테이너 내부 경로')} required value={mount.target} onChange={event => change({ mounts: settings.mounts.map((item, offset) => offset === index ? { ...item, target: event.target.value } : item) })} />
        <label className="checkbox-control"><input type="checkbox" checked={mount.readOnly} onChange={event => change({ mounts: settings.mounts.map((item, offset) => offset === index ? { ...item, readOnly: event.target.checked } : item) })} />{t('읽기 전용')}</label>
        <button type="button" className="icon-button" aria-label={t('볼륨 연결 제거')} data-tooltip={t('볼륨 연결 제거')} onClick={() => change({ mounts: settings.mounts.filter((_, offset) => offset !== index) })}><Icon name="close" size={14} /></button>
      </div>)}<button type="button" className="button small" disabled={settings.mounts.length >= 16} onClick={() => change({ mounts: [...settings.mounts, { name: '', target: '/data', readOnly: false }] })}>{t('볼륨 추가')}</button></fieldset>
      {source.fixedMounts.length > 0 && <details><summary>{t('유지되는 호스트·임시 파일 연결')}</summary>{source.fixedMounts.map((mount, index) => <p className="mono usage-note" key={index}>{mount.kind}: {mount.source} → {mount.target}</p>)}</details>}
      <div className="detail-actions"><button className="button" type="button" disabled={working} onClick={close}>{t('취소')}</button><button className="button primary" disabled={working || blocked}>{working ? t('검사 중…') : t('변경 내용 확인')}</button></div>
    </form>}
  </div></ContainerDialog>{preview && <ConfirmDialog title={t('컨테이너 설정 변경 승인')} label={t('변경 적용')} busy={working} error={null} acknowledged={approved} onAcknowledge={setApproved} onCancel={() => { setPreview(null); setApproved(false); }} onConfirm={() => void execute()}>
    <div className="dialog-target">{preview.before.name} → {preview.after.name}<small>{id}</small></div>
    <p>{preview.recreate ? t('실행 중이면 잠시 중지합니다. 기존 파일을 로컬 보존 이미지에 저장하고 새 컨테이너를 확인한 뒤 기존 컨테이너를 삭제합니다. ID가 바뀌며 기존 로그·프로세스 상태는 이전하지 않습니다.') : t('컨테이너 이름만 변경합니다. ID와 실행 상태는 유지됩니다.')}</p>
    {preview.recreate && <><dl className="detail-meta"><dt>{t('기존 포트')}</dt><dd className="mono pre-wrap">{ports(preview.before)}</dd><dt>{t('변경할 포트')}</dt><dd className="mono pre-wrap">{ports(preview.after)}</dd><dt>{t('기존 네트워크')}</dt><dd>{networkNames(preview.before)}</dd><dt>{t('변경할 네트워크')}</dt><dd>{networkNames(preview.after)}</dd><dt>{t('기존 볼륨 연결')}</dt><dd className="mono pre-wrap">{mounts(preview.before)}</dd><dt>{t('변경할 볼륨 연결')}</dt><dd className="mono pre-wrap">{mounts(preview.after)}</dd></dl><p>{t('볼륨과 그 안의 데이터는 삭제하지 않습니다. 연결을 바꾸면 보이는 데이터가 달라집니다. 실패 시 기존 컨테이너를 복구하며, 복구하지 못한 항목은 실제 ID와 함께 표시합니다.')}</p><p>{t('보존 이미지는 기존 파일과 환경 변수를 포함하며 로컬에 남아 저장 공간을 사용합니다. 볼륨 데이터의 백업은 아닙니다.')}</p></>}
  </ConfirmDialog>}</>;
}
