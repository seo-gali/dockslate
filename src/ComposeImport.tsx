import { useEffect, useRef, useState } from 'react';
import { backend, refreshDashboardAfterMutation } from './api';
import { errorMessage } from './components';


export interface ImportFileSelection {
  token: string | null;
  kind: 'dockerfile' | 'compose';
  path: string | null;
  contextPath?: string;
  dockerfile?: string;
}
export interface ComposeService {
  name: string;
  image: string;
  build: { contextPath: string; dockerfile: string } | null;
  ports: { target: number; published?: string; host_ip?: string; protocol?: string }[] | null;
  volumes: { type: string; source: string; target: string; read_only?: boolean }[] | null;
  networks: string[];
  environmentKeys: string[];
}
export interface ComposePreview {
  token: string;
  path: string;
  contextPath: string;
  project: string;
  engineId: string;
  hasBuild: boolean;
  contextFingerprint: string;
  services: ComposeService[];
  resources: { kind: string; key: string; name: string }[];
  warnings: string[];
}
interface ComposeRunPreview extends ComposePreview {
  previewToken: string;
  imageIds: string[];
  expiresInSeconds: number;
  impact: string;
}
export interface ComposeJob {
  id: string;
  operation: 'build' | 'run';
  project: string;
  state: 'running' | 'completed' | 'failed';
  logs: string;
  error?: string | null;
}
interface Options {
  onBusy?: (busy: boolean) => void;
  onDone?: () => void | Promise<void>;
  onDockerfileSelected?: (selection: ImportFileSelection) => void | Promise<void>;
}

export function useComposeImport({ onBusy, onDone, onDockerfileSelected }: Options = {}) {
  const [preview, setPreview] = useState<ComposePreview | null>(null);
  const [job, setJob] = useState<ComposeJob | null>(null);
  const [approval, setApproval] = useState<ComposeRunPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [working, setWorking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const request = useRef(false);
  const polling = useRef(false);
  const refreshed = useRef<string | null>(null);
  const callbacks = useRef({ onDone, onDockerfileSelected });
  callbacks.current = { onDone, onDockerfileSelected };
  const busy = working || refreshing || job?.state === 'running';
  useEffect(() => { onBusy?.(busy); }, [busy, onBusy]);
  const poll = async () => {
    if (!job || job.state !== 'running' || polling.current) return;
    polling.current = true;
    try { setJob(await backend<ComposeJob>('compose_job_status', { id: job.id })); setPollError(null); }
    catch (failure) { setPollError(errorMessage(failure)); }
    finally { polling.current = false; }
  };
  useEffect(() => {
    if (job?.state !== 'running') return;
    const timer = window.setInterval(() => void poll(), 1000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.state]);
  useEffect(() => {
    if (!job || job.state === 'running' || refreshed.current === job.id) return;
    refreshed.current = job.id;
    setRefreshing(true);
    void (async () => {
      try { await refreshDashboardAfterMutation(); await callbacks.current.onDone?.(); }
      catch (failure) { setError(`작업 후 새로고침 실패: ${errorMessage(failure)}`); }
      finally { setRefreshing(false); }
    })();
  }, [job?.id, job?.state]);
  const choose = async (kind: 'compose' | 'dockerfile') => {
    if (busy || request.current) return;
    request.current = true; setWorking(true); setError(null); setPollError(null);
    let selectedToken: string | null = null;
    let previewReady = false;
    try {
      const selected = await backend<ImportFileSelection>('compose_pick_file', { kind });
      if (!selected.token || !selected.path) return;
      selectedToken = selected.token;
      if (preview) await backend('compose_discard', { id: preview.token });
      setPreview(null); setJob(null); setApproval(null);
      if (kind === 'dockerfile') {
        if (!callbacks.current.onDockerfileSelected) throw new Error('Dockerfile 빌드 연결이 없습니다. 이미지 빌드에서 파일을 선택하세요.');
        await callbacks.current.onDockerfileSelected(selected);
        await backend('compose_discard', { id: selected.token });
        selectedToken = null;
        return;
      }
      const value = await backend<ComposePreview>('compose_preview', { id: selected.token });
      setPreview(value);
      previewReady = true;
      setJob(await backend<ComposeJob>('compose_build_start', { id: selected.token }));
    } catch (failure) {
      setError(errorMessage(failure));
      if (selectedToken && !previewReady) {
        try { await backend('compose_discard', { id: selectedToken }); }
        catch (cleanupFailure) { setError(`${errorMessage(failure)} 파일 잠금 해제 실패: ${errorMessage(cleanupFailure)}`); }
      }
    }
    finally { request.current = false; setWorking(false); }
  };
  const prepareRun = async () => {
    if (!preview || busy || request.current) return;
    request.current = true; setWorking(true); setError(null); setAcknowledged(false);
    try { setApproval(await backend<ComposeRunPreview>('compose_run_preview', { id: preview.token })); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { request.current = false; setWorking(false); }
  };
  const run = async () => {
    if (!approval || !acknowledged || busy || request.current) return;
    request.current = true; setWorking(true); setError(null);
    try { setJob(await backend<ComposeJob>('compose_run_start', { approval: approval.previewToken, approved: true })); setPollError(null); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setApproval(null); setAcknowledged(false); request.current = false; setWorking(false); }
  };
  const discard = async () => {
    if (!preview || busy || request.current) return;
    request.current = true; setWorking(true); setError(null);
    try { await backend('compose_discard', { id: preview.token }); setPreview(null); setJob(null); setApproval(null); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { request.current = false; setWorking(false); }
  };
  return { preview, job, approval, acknowledged, setAcknowledged, busy, working, refreshing, error, pollError, choose, prepareRun, run, discard, poll, cancelApproval: () => { if (!working) { setApproval(null); setAcknowledged(false); } }, supportsDockerfile: !!onDockerfileSelected };
}
