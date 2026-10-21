import { useEffect, useRef, useState } from 'react';
import type { EngineStatus } from './api';
import { ErrorNotice, Icon, StatusBadge, errorMessage } from './components';
import { setLanguage, t, useLanguage } from './i18n';
import { RuntimePanel, type useDockSlateRuntime } from './runtime';
import './engine-setup.css';

export default function EngineSetup({ runtime, engine, onContinue, onSettings, installerMode = false, finishing = false, finishError }: {
  runtime: ReturnType<typeof useDockSlateRuntime>;
  engine: EngineStatus | null;
  onContinue: () => void;
  onSettings: () => void;
  installerMode?: boolean;
  finishing?: boolean;
  finishError?: string | null;
}) {
  const language = useLanguage();
  const [languageError, setLanguageError] = useState<string | null>(null);
  const requestedPreparation = useRef(false);
  const requestedCompletion = useRef(false);
  const connected = engine?.state === 'connected' && runtime.query.data?.state === 'running';
  useEffect(() => {
    if (!installerMode || requestedPreparation.current || runtime.controlsDisabled) return;
    const status = runtime.query.data;
    if (status?.state === 'not_installed') {
      requestedPreparation.current = true;
      void runtime.prepareInstall();
    } else if (status?.state === 'stopped' && status.blockedReasons.length === 0) {
      requestedPreparation.current = true;
      runtime.requestAction('start');
    }
  }, [installerMode, runtime.controlsDisabled, runtime.query.data, runtime.prepareInstall, runtime.requestAction]);
  useEffect(() => {
    if (!installerMode || !connected || runtime.busy || runtime.preparing || finishing || finishError || requestedCompletion.current) return;
    requestedCompletion.current = true;
    onContinue();
  }, [installerMode, connected, runtime.busy, runtime.preparing, finishing, finishError, onContinue]);
  return <main className="engine-setup">
    <header className="setup-topbar"><strong>DockSlate</strong><label>{t('언어')}<select value={language} onChange={event => { setLanguageError(null); void setLanguage(event.target.value as 'ko' | 'en').catch(error => setLanguageError(errorMessage(error))); }}><option value="ko">한국어</option><option value="en">English</option></select></label></header>
    <section className="setup-intro"><StatusBadge tone={connected ? 'success' : 'accent'}>{connected ? t('연결됨') : t('처음 시작하기')}</StatusBadge><h1>{connected ? t('Docker Engine을 사용할 준비가 됐습니다') : t('Docker Engine 준비')}</h1><p>{t('DockSlate에서 Docker Engine, Docker CLI, Buildx와 Compose를 함께 설치합니다. Linux 컨테이너는 내부 WSL 2에서 실행됩니다.')}</p></section>
    {languageError && <ErrorNotice message={languageError} />}
    {finishError && <ErrorNotice message={finishError} />}
    <ol className="setup-components" aria-label={t('설치 구성')}><li><Icon name="containers" /><div><strong>Docker Engine</strong><span>{t('컨테이너·이미지·볼륨을 관리하는 전용 엔진')}</span></div></li><li><Icon name="images" /><div><strong>Docker CLI · Compose · Buildx</strong><span>{t('Dockerfile 빌드와 Compose 프로젝트 실행')}</span></div></li></ol>
    <RuntimePanel runtime={runtime} />
    <p className="setup-note">{t('인터넷 연결과 Windows 11·WSL 2가 필요합니다. 설치 전 대상과 영향을 확인하며, 기존 컨테이너와 데이터를 자동으로 변경하지 않습니다.')}</p>
    <footer className="setup-actions">{!installerMode && <button className="button" disabled={runtime.busy || runtime.preparing} onClick={onSettings}>{t('설정 확인')}</button>}<button className="button primary" disabled={!connected || runtime.busy || runtime.preparing || finishing} onClick={onContinue}>{finishing ? t('확인 중…') : installerMode ? t('설치 완료') : t('DockSlate 시작')}</button></footer>
  </main>;
}
