import { useEffect, useRef, useState } from 'react';
import { backend } from './api';
import { ErrorNotice, errorMessage } from './components';
import type { RuntimeStatus } from './runtime';
import { t } from './i18n';

interface StartupSettings {
  startEngine: boolean;
  startApp: boolean;
  conflict: boolean;
  executable: string;
  autoStartAllowed: boolean;
}

export function useStartupSettings() {
  const [data, setData] = useState<StartupSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);
  const load = async () => {
    setLoading(true); setError(null);
    try { setData(await backend<StartupSettings>('startup_settings')); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const change = async (startEngine: boolean, startApp: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true; setLoading(true); setError(null);
    try { setData(await backend<StartupSettings>('startup_set', { startEngine, startApp })); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { inFlight.current = false; setLoading(false); }
  };
  return { data, error, loading, load, change };
}

export function StartupPanel({ settings, runtime, busy }: { settings: ReturnType<typeof useStartupSettings>; runtime: RuntimeStatus | null; busy: boolean }) {
  const value = settings.data;
  const installed = runtime && ['running', 'stopped', 'starting', 'stopping'].includes(runtime.state) && runtime.blockedReasons.length === 0;
  const disabled = busy || settings.loading || !value || value.conflict;
  return <section className="settings-panel appearance-panel" aria-label={t('자동 시작')}>
    <h2>{t('자동 시작')}</h2>
    {settings.error && <ErrorNotice message={settings.error} onRetry={() => void settings.load()} />}
    {value?.conflict && <ErrorNotice message={t('다른 실행 파일의 자동 시작 등록이 있습니다. 기존 등록을 보존했습니다. Windows 시작 앱에서 기존 DockSlate 등록을 확인하세요.')} />}
    <div className="appearance-row"><div><label htmlFor="startup-engine">{t('엔진 자동 시작')}</label><p className="muted">{t('Windows 로그인 또는 DockSlate 실행 시 설치된 전용 엔진을 시작합니다.')}</p></div><input id="startup-engine" type="checkbox" checked={value?.startEngine ?? false} disabled={disabled || (!installed && !value?.startEngine)} onChange={event => void settings.change(event.target.checked, value?.startApp ?? false)} /></div>
    <div className="appearance-row"><div><label htmlFor="startup-app">{t('Windows 로그인 시 DockSlate 창 열기')}</label><p className="muted">{t('엔진만 자동 시작할 때는 창을 열지 않습니다.')}</p></div><input id="startup-app" type="checkbox" checked={value?.startApp ?? false} disabled={disabled} onChange={event => void settings.change(value?.startEngine ?? false, event.target.checked)} /></div>
    {!installed && !value?.startEngine && <p className="muted">{t('엔진을 설치한 뒤 엔진 자동 시작을 선택할 수 있습니다.')}</p>}
    <p className="appearance-row muted" role="status">{settings.loading ? t('확인 중…') : t('다음 시작부터 적용됩니다. 컨테이너는 기존 재시작 정책을 따릅니다.')}</p>
  </section>;
}
