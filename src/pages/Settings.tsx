import { useEffect, useState } from 'react';
import { engineLabel, type EngineProps } from '../App';
import { ErrorNotice, PageHeader, RefreshButton, StatusBadge } from '../components';
import { RuntimePanel, useDockSlateRuntime } from '../runtime';
import { defaultAppearance, useAppearance } from '../appearance';
import { t, setLanguage, useLanguage } from '../i18n';

export default function Settings(props: EngineProps & { runtime: ReturnType<typeof useDockSlateRuntime>; runtimeRequest?: number }) {
  const engine = props.engine;
  const runtime = props.runtime;
  const refresh = props.reloadEngine;
  const { appearance, setAppearance } = useAppearance();
  const language = useLanguage();
  const [languageError, setLanguageError] = useState<string | null>(null);
  const [tab, setTab] = useState<'appearance' | 'runtime' | 'connection'>('appearance');
  useEffect(() => { if (props.runtimeRequest) setTab('runtime'); }, [props.runtimeRequest]);
  return <>
    <PageHeader title={t("Settings")}><RefreshButton busy={props.engineLoading || runtime.query.loading || runtime.preparing} onClick={() => void refresh()} /></PageHeader>
    <div className="page-tabs" role="tablist" aria-label={t('설정 보기')}>{(['appearance', 'runtime', 'connection'] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{t({ appearance: '화면', runtime: '런타임', connection: '엔진 연결 정보' }[value])}</button>)}</div>
    <div hidden={tab !== 'appearance'}><section className="settings-panel appearance-panel" aria-label={t("화면 설정")}>
      <h2>{t("화면")}</h2>
      <div className="appearance-row"><label htmlFor="display-language">{t("언어")}</label><select id="display-language" className="text-input language-select" value={language} onChange={event => { setLanguageError(null); void setLanguage(event.target.value === 'en' ? 'en' : 'ko').catch(() => setLanguageError(t('언어 파일을 불러오지 못했습니다. 다시 선택하세요.'))); }}><option value="ko">{t("한국어")}</option><option value="en">English</option></select></div>
      {languageError && <p className="dialog-error" role="alert">{languageError}</p>}
      <div className="appearance-row"><span>{t("테마")}</span><div className="segmented" role="group" aria-label={t("테마 선택")}>{(['dark', 'light'] as const).map(theme => <button key={theme} className={appearance.theme === theme ? 'active' : ''} aria-pressed={appearance.theme === theme} onClick={() => setAppearance(value => ({ ...value, theme }))}>{theme === 'dark' ? t("다크") : t("라이트")}</button>)}</div></div>
      <div className="appearance-row"><span>{t("글자 크기")}</span><div className="font-size-controls"><button className="button small" aria-label={t("글자 작게")} disabled={appearance.fontSize <= 11} onClick={() => setAppearance(value => ({ ...value, fontSize: value.fontSize - 1 }))}>A−</button><output aria-label={t("글자 크기")} aria-live="polite">{appearance.fontSize}px</output><button className="button small" aria-label={t("글자 크게")} disabled={appearance.fontSize >= 16} onClick={() => setAppearance(value => ({ ...value, fontSize: value.fontSize + 1 }))}>A+</button><button className="button small subtle" onClick={() => setAppearance(value => ({ ...value, fontSize: defaultAppearance.fontSize }))}>{t("기본값")}</button></div></div>
    </section></div>
    <div hidden={tab !== 'runtime'}><RuntimePanel runtime={runtime} /></div>
    {props.engineError && <ErrorNotice message={props.engineError} onRetry={() => void props.reloadEngine()} />}
    <section hidden={tab !== 'connection'} className="settings-panel engine-details"><h2>{t("엔진 연결 정보")}</h2>
      <dl className="settings-properties">
        <dt>{t("연결 상태")}</dt><dd><StatusBadge tone={engine?.state === 'connected' ? 'success' : engine?.state === 'permission_denied' ? 'danger' : 'warning'}>{engineLabel(engine, props.engineLoading)}</StatusBadge></dd>
        <dt>{t("연결 대상")}</dt><dd>{engine?.context ?? t("미확인")}</dd><dt>{t("엔진 종류")}</dt><dd>{engine?.engine ?? t("미확인")}</dd>
        <dt>{t("서버 버전")}</dt><dd>{engine?.serverVersion ?? t("미확인")}</dd><dt>{t("API 버전")}</dt><dd>{engine?.apiVersion ?? t("미확인")}</dd>
        <dt>Endpoint</dt><dd className="mono">{engine?.endpoint ?? t("미확인")}</dd><dt>{t("런타임 확인 경로")}</dt><dd className="mono">{engine?.ownerPath ?? t("미확인")}</dd>
        <dt>{t("진단")}</dt><dd>{(engine?.message ? t(engine.message) : null) ?? (props.engineLoading ? t("연결 정보를 확인하고 있습니다.") : props.engineError ?? t("엔진 정보를 읽지 못했습니다."))}</dd>
      </dl>
    </section>
  </>;
}
