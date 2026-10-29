import { useCallback, useEffect, useState } from 'react';
import { type EngineProps } from '../App';
import { Icon, PageHeader } from '../components';
import DockerUsage from './DockerUsage';
import WslDisks from './WslDisks';
import type { useDockSlateRuntime } from '../runtime';
import { t } from "../i18n";


export default function DiskManager(props: EngineProps & { onDiskBusy: (busy: boolean) => void; runtime: ReturnType<typeof useDockSlateRuntime>; dockerTabRequest: number }) {
  const [tab, setTab] = useState<'docker' | 'wsl'>('docker');
  const [compacting, setCompacting] = useState(false);
  const updateCompacting = useCallback((busy: boolean) => { setCompacting(busy); props.onDiskBusy(busy); }, [props.onDiskBusy]);
  const onWslLoading = useCallback((_loading: boolean) => {}, []);
  useEffect(() => { if (props.dockerTabRequest > 0) setTab('docker'); }, [props.dockerTabRequest]);
  return <><PageHeader title={t("Disk Manager")}></PageHeader><div className="page-tabs" role="tablist" aria-label={t("디스크 관리 종류")}><button role="tab" aria-selected={tab === 'docker'} className={tab === 'docker' ? 'active' : ''} disabled={compacting} onClick={() => setTab('docker')}><Icon name="images" size={16} />{t("Docker Usage")}</button><button role="tab" aria-selected={tab === 'wsl'} className={tab === 'wsl' ? 'active' : ''} disabled={compacting} onClick={() => setTab('wsl')}><Icon name="disk" size={16} />{t("WSL Disks")}</button></div><div data-tab="docker" hidden={tab !== 'docker'}><DockerUsage {...props} /></div><div data-tab="wsl" hidden={tab !== 'wsl'}><WslDisks revision={0} onLoading={onWslLoading} onCompacting={updateCompacting} runtime={props.runtime} openRuntimeSettings={props.openRuntimeSettings} /></div></>;
}
