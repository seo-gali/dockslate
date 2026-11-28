import type { useComposeImport } from './ComposeImport';
import { ComposeSummary } from './ComposeImportPanel';
import { ConfirmDialog, ErrorNotice } from './components';
import { t } from './i18n';

export function MigrationComposePanel({ compose, blocked }: { compose: ReturnType<typeof useComposeImport>; blocked: boolean }) {
  const disabled = blocked || compose.busy;
  return <>
    {compose.error && <ErrorNotice message={compose.error} />}
    {compose.preview && <section className="panel">
      <h3>{t('Compose 설정으로 새로 실행')}</h3>
      <ComposeSummary preview={compose.preview} />
      {compose.preview.warnings.map(warning => <p className="usage-note" key={warning}>{t(warning)}</p>)}
      <div className="toolbar"><button className="button" disabled={disabled} onClick={() => void compose.discard()}>{t('설정 닫기')}</button><button className="button primary" disabled={disabled || !!compose.job} onClick={() => void compose.prepareRun()}>{t('실행 미리보기')}</button></div>
    </section>}
    {compose.job && <div aria-live="polite" role="status"><h3>{t(compose.job.state === 'running' ? 'Compose 서비스 실행 중' : compose.job.state === 'completed' ? 'Compose 서비스 실행 완료' : 'Compose 서비스 실행 중단')}</h3><p>{t(compose.job.logs)}</p>{compose.job.error && <ErrorNotice message={compose.job.error} />}</div>}
    {compose.pollError && <ErrorNotice message={compose.pollError} onRetry={() => void compose.poll()} />}
    {compose.approval && <ConfirmDialog title={t('Compose 서비스 실행 승인')} label={t('서비스 생성 및 시작')} busy={compose.working} error={null} acknowledged={compose.acknowledged} onAcknowledge={compose.setAcknowledged} onCancel={compose.cancelApproval} onConfirm={() => void compose.run()}>
      <p>{t(compose.approval.impact)}</p>
      <ComposeSummary preview={compose.approval} />
      {compose.approval.warnings.map(warning => <p key={warning}>{t(warning)}</p>)}
      <p>{t('승인은 {seconds}초 동안 유효합니다.', { seconds: compose.approval.expiresInSeconds })}</p>
    </ConfirmDialog>}
  </>;
}
