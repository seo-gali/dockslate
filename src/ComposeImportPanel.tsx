import { ResizableTable } from './ResizableColumns';
import { useTableRows } from './TableRows';
import { ConfirmDialog, Icon } from './components';
import { t } from './i18n';
import type { ComposePreview, ComposeService, useComposeImport } from './ComposeImport';

function ports(service: ComposeService) {
  return service.ports?.map(port => `${port.host_ip ? `${port.host_ip}:` : ''}${port.published || t('자동')} → ${port.target}/${port.protocol || 'tcp'}`).join(', ') || t('없음');
}
function ComposeSummary({ preview }: { preview: ComposePreview }) {
  const services = useTableRows(preview.services, [{ value: service => service.name }, { value: service => service.build?.contextPath }, { value: ports }, { value: service => service.volumes?.map(volume => volume.target).join(', ') }]);
  return <>
    <dl className="detail-grid"><dt>{t("선택 파일")}</dt><dd className="mono">{preview.path}</dd><dt>{t("프로젝트")}</dt><dd className="mono">{preview.project}</dd><dt>{t("대상 엔진")}</dt><dd className="mono">{preview.engineId}</dd></dl>
    <div className="table-wrap"><ResizableTable storageKey="compose-services" controls={services} widths={[300,260,180,300]}><thead><tr><th>{t("서비스 / 이미지")}</th><th>{t("빌드 폴더")}</th><th>{t("공개 포트")}</th><th>{t("볼륨 연결")}</th></tr></thead><tbody>{services.rows.map(service => <tr key={service.name}><td><strong>{service.name}</strong><div className="mono">{service.image}</div>{service.environmentKeys.length > 0 && <div className="usage-note">{t("환경 변수") + " "}{service.environmentKeys.length}{t("개")}</div>}</td><td className="mono">{service.build ? <><div>{service.build.contextPath}</div><div className="usage-note">{service.build.dockerfile}</div></> : t("로컬 이미지 사용")}</td><td className="mono">{ports(service)}</td><td className="mono">{service.volumes?.map(volume => `${volume.source} → ${volume.target}${volume.read_only ? ` (${t('읽기 전용')})` : ''}`).join(', ') || t("없음")}</td></tr>)}</tbody></ResizableTable></div>
    {preview.resources.length > 0 && <p className="usage-note">{t("새 리소스:") + " "}{preview.resources.map(resource => `${resource.kind === 'volumes' ? t('볼륨') : t('네트워크')} ${resource.name}`).join(' · ')}</p>}
  </>;
}

export function ComposeImportPanel({ compose, connected, blocked = false }: { compose: ReturnType<typeof useComposeImport>; connected: boolean; blocked?: boolean }) {
  const disabled = !connected || blocked || compose.busy;
  const canRun = compose.job?.operation === 'build' && compose.job.state === 'completed';
  return <section className="panel image-build-panel" aria-label={t("파일에서 빌드")} aria-busy={compose.busy}>
    <div className="section-heading"><h2>{t("파일에서 빌드")}</h2><div className="toolbar">{compose.supportsDockerfile && <button className="button" disabled={disabled} onClick={() => void compose.choose('dockerfile')}><Icon name="images" size={16} />{t("Dockerfile 선택")}</button>}<button className="button primary" disabled={disabled} onClick={() => void compose.choose('compose')}><Icon name="images" size={16} />{compose.working ? t("파일 처리 중…") : t("Compose 파일 선택")}</button></div></div>
    {!connected && <p className="usage-note">{t("Settings에서 전용 엔진을 시작하면 파일을 가져올 수 있습니다.")}</p>}
    {compose.preview && <ComposeSummary preview={compose.preview} />}
    {compose.error && <p className="dialog-error" role="alert">{compose.error}</p>}
    {compose.job && <div className="build-result" data-compose-state={compose.job.state}><div className="section-heading"><strong className={compose.job.state === 'failed' ? 'danger' : compose.job.state === 'completed' ? 'success' : 'accent'} role="status">Compose {compose.job.operation === 'build' ? t("빌드") : t("실행")} · {compose.job.state === 'running' ? t("진행 중") : compose.job.state === 'completed' ? t("완료") : t("실패")}</strong>{canRun && <button className="button primary" disabled={disabled} onClick={() => void compose.prepareRun()}><Icon name="play" size={16} />{t("실행 미리보기")}</button>}</div><p className="usage-note">{compose.job.logs}</p>{compose.job.error && <p className="dialog-error" role="alert">{compose.job.error}</p>}{compose.job.state === 'running' && <p className="usage-note">{t("메뉴를 이동해도 작업은 계속됩니다. 완료 또는 제한 시간 종료까지 엔진 중지와 앱 종료가 차단됩니다.")}</p>}</div>}
    {compose.pollError && <div className="notice error" role="alert"><p>{t("작업 상태 확인 실패:") + " "}{compose.pollError}</p><button className="button small" onClick={() => void compose.poll()}>{t("다시 확인")}</button></div>}
    {compose.preview && !compose.busy && <button className="button subtle small" onClick={() => void compose.discard()}>{t("파일 선택 닫기")}</button>}
    {compose.approval && <ConfirmDialog title={t("Compose 서비스 실행")} label="서비스 생성 및 시작" busy={compose.working} error={null} acknowledged={compose.acknowledged} onAcknowledge={compose.setAcknowledged} onCancel={compose.cancelApproval} onConfirm={() => void compose.run()}><p>{compose.approval.impact}</p><ComposeSummary preview={compose.approval} /><p className="usage-note">{t("승인은") + " "}{compose.approval.expiresInSeconds}{t("초 동안 유효합니다. 소스·이미지·엔진이 변경되면 실행을 차단합니다.")}</p></ConfirmDialog>}
  </section>;
}
