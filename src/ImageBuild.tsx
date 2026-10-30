import { useEffect, useRef, useState } from 'react';
import { backend, refreshDashboardAfterMutation, useBackendQuery } from './api';
import { errorMessage } from './components';


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
  const start = async (selected?: { contextPath: string; dockerfile: string; tag: string }) => {
    const source = selected ?? { contextPath, dockerfile, tag };
    if (busy || request.current || targets.loading || !target || targets.data?.selectionError || !source.contextPath.trim() || !source.dockerfile.trim() || !source.tag.trim()) { setError('빌드 대상과 소스 파일을 확인하세요.'); return; }
    if (selected) { setContextPath(selected.contextPath); setDockerfile(selected.dockerfile); setTag(selected.tag); }
    request.current = true;
    setStarting(true); setJob(null); setError(null); setStatusError(null);
    try { update(await backend<ImageBuildStatus>('image_build_start', { contextPath: source.contextPath.trim(), dockerfile: source.dockerfile.trim(), tag: source.tag.trim(), noCache })); }
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
  const discard = () => {
    if (busy || picking || request.current) return;
    setContextPath(''); setDockerfile('Dockerfile'); setTag(''); setNoCache(false);
    setJob(null); setError(null); setStatusError(null);
  };
  return { contextPath, setContextPath, dockerfile, setDockerfile, tag, setTag, noCache, setNoCache, job, busy, starting, refreshing, picking, error, statusError, start, pick, poll, discard, target, targetLoading: targets.loading, targetError: targets.data?.selectionError ?? targets.error };
}
