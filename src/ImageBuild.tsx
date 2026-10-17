import { useEffect, useRef, useState } from 'react';
import { backend, refreshDashboardAfterMutation, useBackendQuery } from './api';
import { Icon, errorMessage } from './components';

export interface ImageBuildStatus {
  id: string;
  state: 'running' | 'completed' | 'failed';
  contextPath: string;
  dockerfile: string;
  tag: string;
  logs: string | null;
  logVersion?: number;
  truncated: boolean;
  error?: string | null;
  imageId?: string | null;
  builder?: string | null;
}

interface BuildTarget { selectedBuilder: string; selectionError?: string | null; builders: { name: string; driver: string; nodes: { endpoint: string }[] }[] }

export function useImageBuild(onBusy?: (busy: boolean) => void) {
  const targets = useBackendQuery<BuildTarget>('builds_snapshot');
  const target = targets.data?.builders.find(value => value.name === targets.data?.selectedBuilder) ?? null;
  const [contextPath, setContextPath] = useState('');
  const [dockerfile, setDockerfile] = useState('Dockerfile');
  const [tag, setTag] = useState('');
  const [noCache, setNoCache] = useState(false);
  const [job, setJob] = useState<ImageBuildStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const request = useRef(false);
  const pollRequest = useRef(false);
  const refreshed = useRef<string | null>(null);
  const busy = starting || refreshing || job?.state === 'running';
  useEffect(() => { onBusy?.(busy); }, [busy, onBusy]);
  const update = (value: ImageBuildStatus) => setJob(previous => ({ ...value, logs: value.logs ?? previous?.logs ?? '' }));
  const poll = async () => {
    if (!job || job.state !== 'running' || pollRequest.current) return;
    pollRequest.current = true;
    try {
      update(await backend<ImageBuildStatus>('image_build_status', { id: job.id, logVersion: job.logVersion }));
      setStatusError(null);
    } catch (failure) { setStatusError(`빌드 상태를 확인하지 못했습니다: ${errorMessage(failure)}`); }
    finally { pollRequest.current = false; }
  };
  useEffect(() => {
    if (job?.state !== 'running') return;
    const timer = window.setInterval(() => void poll(), 1000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.state, job?.logVersion]);
  useEffect(() => {
    if (!job || job.state === 'running' || refreshed.current === job.id) return;
    refreshed.current = job.id;
    setRefreshing(true);
    void refreshDashboardAfterMutation().finally(() => setRefreshing(false));
  }, [job]);
  const start = async () => {
    if (busy || request.current || targets.loading || !target || targets.data?.selectionError || !contextPath.trim() || !dockerfile.trim() || !tag.trim()) return;
    request.current = true;
    setStarting(true); setJob(null); setError(null); setStatusError(null);
    try { update(await backend<ImageBuildStatus>('image_build_start', { contextPath: contextPath.trim(), dockerfile: dockerfile.trim(), tag: tag.trim(), noCache })); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setStarting(false); request.current = false; }
  };
  const pick = async () => {
    if (busy || picking) return;
    setPicking(true); setError(null);
    try {
      const result = await backend<{ path: string | null }>('image_build_pick_context');
      if (result.path) setContextPath(result.path);
    } catch (failure) { setError(`빌드 폴더를 선택하지 못했습니다: ${errorMessage(failure)}`); }
    finally { setPicking(false); }
  };
  return { contextPath, setContextPath, dockerfile, setDockerfile, tag, setTag, noCache, setNoCache, job, busy, starting, refreshing, picking, error, statusError, start, pick, poll, target, targetLoading: targets.loading, targetError: targets.data?.selectionError ?? targets.error };
}

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
  return <section className="panel image-build-panel" aria-label="이미지 빌드" aria-busy={build.busy}>
    <div className="section-heading"><h2>이미지 빌드</h2><button type="button" className="icon-button" disabled={build.busy || build.picking} onClick={onClose} aria-label="빌드 패널 닫기" title="빌드 패널 닫기"><Icon name="close" /></button></div>
    <p className="usage-note" aria-label="이미지 빌드 대상">빌드 대상: {build.targetLoading ? '확인 중…' : build.target ? `${build.target.name} · ${build.target.driver}` : '선택 필요'}{build.target?.nodes.map(node => ` · ${node.endpoint}`).join('')}</p>
    {build.target && build.target.driver !== 'docker' && <p className="usage-note">선택한 빌더의 노드로 빌드 소스를 전송합니다. Builds의 빌더 목록에서 대상을 변경할 수 있습니다.</p>}
    {build.targetError && <p className="dialog-error" role="alert">{build.targetError}</p>}
    <form onSubmit={event => { event.preventDefault(); if (connected && !blocked) void build.start(); }}>
      <div className="toolbar" style={{ alignItems: 'flex-end' }}><div className="field"><label htmlFor="build-context">빌드 폴더</label><input id="build-context" className="text-input mono" placeholder="Dockerfile과 소스가 있는 Windows 폴더" value={build.contextPath} disabled={disabled} onChange={event => build.setContextPath(event.target.value)} spellCheck={false} maxLength={32760} /></div><button className="button" type="button" disabled={disabled} onClick={() => void build.pick()}>{build.picking ? '폴더 선택 중…' : '폴더 선택'}</button></div>
      <div className="toolbar"><div className="field"><label htmlFor="build-dockerfile">Dockerfile · 빌드 폴더 기준 경로</label><input id="build-dockerfile" className="text-input mono" value={build.dockerfile} disabled={disabled} onChange={event => build.setDockerfile(event.target.value)} spellCheck={false} maxLength={1024} /></div><div className="field"><label htmlFor="build-tag">이미지 이름과 태그</label><input id="build-tag" className="text-input mono" placeholder="예: my-app:latest" value={build.tag} disabled={disabled} onChange={event => build.setTag(event.target.value)} spellCheck={false} maxLength={256} /></div></div>
      <div className="toolbar"><label className="checkbox-control"><input id="build-no-cache" type="checkbox" checked={build.noCache} disabled={disabled} onChange={event => build.setNoCache(event.target.checked)} />캐시를 사용하지 않고 빌드</label><button className="button primary" type="submit" disabled={disabled || !connected || !canBuild || !build.contextPath.trim() || !build.dockerfile.trim() || !build.tag.trim()}><Icon name="images" size={16} />{build.starting ? '빌드 준비 중…' : job?.state === 'running' ? '빌드 중…' : '빌드 시작'}</button></div>
    </form>
    <p className="usage-note">같은 태그가 있으면 새 이미지로 변경됩니다.</p>
    {!connected && <p className="usage-note">Settings에서 엔진을 시작하면 빌드할 수 있습니다.</p>}
    {build.error && <p className="dialog-error" role="alert">{build.error}</p>}
    {job && <div className="build-result" data-build-state={job.state}>
      <div className="section-heading"><strong className={job.state === 'failed' ? 'danger' : job.state === 'completed' ? 'success' : 'accent'} role="status">{job.state === 'running' ? '빌드 중' : job.state === 'completed' ? '빌드 완료' : '빌드 실패'} · {job.tag}</strong><div className="build-log-controls"><label className="checkbox-control"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />자동 스크롤</label><button className="button small subtle" type="button" disabled={!job.logs} onClick={() => void copy()}><Icon name="copy" size={14} />로그 복사</button></div></div>
      <pre className="logs build-logs" aria-label="이미지 빌드 로그" tabIndex={0} ref={logs}>{job.logs || '빌드 로그를 기다립니다…'}</pre>
      {job.builder && <p className="usage-note">사용한 빌더: {job.builder}</p>}
      {job.truncated && <p className="usage-note">출력이 길어 최근 로그만 표시합니다.</p>}
      {job.imageId && <p className="usage-note mono">{job.imageId}</p>}
      {job.error && <p className="dialog-error" role="alert">{job.error}</p>}
      {job.state === 'running' && <p className="usage-note">다른 메뉴로 이동해도 빌드는 계속됩니다. 완료될 때까지 엔진을 중지하거나 앱을 종료할 수 없습니다.</p>}
    </div>}
    {build.statusError && <div className="notice error" role="alert"><div><p>{build.statusError}</p></div><button type="button" className="button small" onClick={() => void build.poll()}>상태 다시 확인</button></div>}
    {copyError && <p className="dialog-error" role="alert">{copyError}</p>}
  </section>;
}
