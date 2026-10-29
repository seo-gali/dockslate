import { useEffect, useState } from 'react';
import type { EngineProps } from '../App';
import { PageHeader } from '../components';
import Networks from '../Networks';
import Volumes from './Volumes';
import { t } from "../i18n";


export default function Resources(props: EngineProps & { onBusy?: (busy: boolean) => void }) {
  const [tab, setTab] = useState<'volumes' | 'networks'>('volumes');
  const [volumeBusy, setVolumeBusy] = useState(false);
  const [networkBusy, setNetworkBusy] = useState(false);
  useEffect(() => { props.onBusy?.(volumeBusy || networkBusy); }, [volumeBusy, networkBusy, props.onBusy]);
  return <>
    <PageHeader title={t("리소스")}></PageHeader>
    <div className="page-tabs" role="tablist" aria-label={t("리소스 관리")}>
      <button role="tab" aria-selected={tab === 'volumes'} className={tab === 'volumes' ? 'active' : ''} onClick={() => setTab('volumes')}>{t("볼륨")}</button>
      <button role="tab" aria-selected={tab === 'networks'} className={tab === 'networks' ? 'active' : ''} onClick={() => setTab('networks')}>{t("네트워크")}</button>
    </div>
    <div className="list-pane" hidden={tab !== 'volumes'}><Volumes {...props} noPageHeader onBusy={setVolumeBusy} /></div>
    <div className="list-pane" hidden={tab !== 'networks'}><Networks {...props} noPageHeader onBusy={setNetworkBusy} /></div>
  </>;
}
