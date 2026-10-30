import { useEffect, useRef, useState } from 'react';
import { Icon, errorMessage } from './components';
import { t } from './i18n';
import type { useImageBuild } from './ImageBuild';

export function ImageBuildPanel({ build, connected, blocked, onClose }: { build: ReturnType<typeof useImageBuild>; connected: boolean; blocked: boolean; onClose: () => void }) {
  const logs = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const [copyError, setCopyError] = useState<string | null>(null);
  const job = build.job;
  const disabled = build.busy || build.picking || blocked;
  const canBuild = !!build.target && !build.targetLoading && !build.targetError;
  useEffect(() => { if (follow && logs.current) logs.current.scrollTop = logs.current.scrollHeight; }, [job?.logs, follow]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(job?.logs ?? ''); setCopyError(null); }
    catch (failure) { setCopyError(`로그 복사 실패: ${errorMessage(failure)}`); }
  };
  return <section className="panel image-build-panel" aria-label={t("이미지 빌드")} aria-busy={build.busy}>
    <div className="section-heading"><h2>{t("이미지 빌드")}</h2></div>
    <p className="usage-note" aria-label={t("이미지 빌드 대상")}>{t("빌드 대상:") + " "}{build.targetLoading ? t("확인 중…") : build.target ? `${build.target.name} · ${build.target.driver}` : t("선택 필요")}{build.target?.nodes.map(node => ` · ${node.endpoint}`).join('')}</p>
    {build.target && build.target.driver !== 'docker' && <p className="usage-note">{t("선택한 빌더의 노드로 빌드 소스를 전송합니다. Builds의 빌더 목록에서 대상을 변경할 수 있습니다.")}</p>}
    {build.targetError && <p className="dialog-error" role="alert">{build.targetError}</p>}
    <form onSubmit={event => { event.preventDefault(); if (connected && !blocked) void build.start(); }}>
      <div className="toolbar" style={{ alignItems: 'flex-end' }}><div className="field"><label htmlFor="build-context">{t("빌드 폴더")}</label><input id="build-context" className="text-input mono" placeholder={t("Dockerfile과 소스가 있는 Windows 폴더")} value={build.contextPath} disabled={disabled} onChange={event => build.setContextPath(event.target.value)} spellCheck={false} maxLength={32760} /></div><button className="button" type="button" disabled={disabled} onClick={() => void build.pick()}>{build.picking ? t("폴더 선택 중…") : t("폴더 선택")}</button></div>
      <div className="toolbar"><div className="field"><label htmlFor="build-dockerfile">{t("Dockerfile · 빌드 폴더 기준 경로")}</label><input id="build-dockerfile" className="text-input mono" value={build.dockerfile} disabled={disabled} onChange={event => build.setDockerfile(event.target.value)} spellCheck={false} maxLength={1024} /></div><div className="field"><label htmlFor="build-tag">{t("이미지 이름과 태그")}</label><input id="build-tag" className="text-input mono" placeholder={t("예: my-app:latest")} value={build.tag} disabled={disabled} onChange={event => build.setTag(event.target.value)} spellCheck={false} maxLength={256} /></div></div>
      <div className="toolbar"><label className="checkbox-control"><input id="build-no-cache" type="checkbox" checked={build.noCache} disabled={disabled} onChange={event => build.setNoCache(event.target.checked)} />{t("캐시를 사용하지 않고 빌드")}</label><button className="button primary" type="submit" disabled={disabled || !connected || !canBuild || !build.contextPath.trim() || !build.dockerfile.trim() || !build.tag.trim()}><Icon name="images" size={16} />{build.starting ? t("빌드 준비 중…") : job?.state === 'running' ? t("빌드 중…") : t("다시 빌드")}</button></div>
    </form>
    <p className="usage-note">{t("같은 태그가 있으면 새 이미지로 변경됩니다.")}</p>
    {!connected && <p className="usage-note">{t("Settings에서 엔진을 시작하면 빌드할 수 있습니다.")}</p>}
    {build.error && <p className="dialog-error" role="alert">{build.error}</p>}
    {job && <div className="build-result" data-build-state={job.state}>
      <div className="section-heading"><strong className={job.state === 'failed' ? 'danger' : job.state === 'completed' ? 'success' : 'accent'} role="status">{job.state === 'running' ? t("빌드 중") : job.state === 'completed' ? t("빌드 완료") : t("빌드 실패")} · {job.tag}</strong><div className="build-log-controls"><label className="checkbox-control"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />{t("자동 스크롤")}</label><button className="button small subtle" type="button" disabled={!job.logs} onClick={() => void copy()}><Icon name="copy" size={14} />{t("로그 복사")}</button></div></div>
      <pre className="logs build-logs" aria-label={t("이미지 빌드 로그")} tabIndex={0} ref={logs}>{job.logs || t("빌드 로그를 기다립니다…")}</pre>
      {job.builder && <p className="usage-note">{t("사용한 빌더:") + " "}{job.builder}</p>}
      {job.truncated && <p className="usage-note">{t("출력이 길어 최근 로그만 표시합니다.")}</p>}
      {job.imageId && <p className="usage-note mono">{job.imageId}</p>}
      {job.error && <p className="dialog-error" role="alert">{job.error}</p>}
      {job.state === 'running' && <p className="usage-note">{t("다른 메뉴로 이동해도 빌드는 계속됩니다. 완료될 때까지 엔진을 중지하거나 앱을 종료할 수 없습니다.")}</p>}
    </div>}
    {build.statusError && <div className="notice error" role="alert"><div><p>{build.statusError}</p></div><button type="button" className="button small" onClick={() => void build.poll()}>{t("상태 다시 확인")}</button></div>}
    {copyError && <p className="dialog-error" role="alert">{copyError}</p>}
    <div className="build-panel-footer"><button type="button" className="button" disabled={build.busy || build.picking} onClick={onClose}>{t("파일 선택 닫기")}</button></div>
  </section>;
}
