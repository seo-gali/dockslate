import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { errorMessage } from './components';

export interface EngineStatus {
  state: 'connected' | 'busy' | 'unavailable' | 'unsupported' | 'permission_denied';
  context: string | null;
  endpoint: string | null;
  engine: string | null;
  serverVersion: string | null;
  apiVersion: string | null;
  ownerPath: string | null;
  id?: string;
  os?: string;
  kernel?: string;
  architecture?: string;
  storageDriver?: string;
  cpuCount?: number;
  memoryTotalBytes?: number;
  dockerRootDir?: string;
  appVersion?: string;
  message: string;
}
export interface OverviewData {
  engine: EngineStatus;
  containersRunning: number | null;
  containersStopped: number | null;
  images: number | null;
  dockerBytes: number | null;
  reclaimableBytes: number | null;
}
export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  publishedPorts?: { privatePort: number; publicPort: number; protocol: string; ip: string }[];
  composeProject: string | null;
}
export interface DockerImage {
  id: string;
  tags: string[];
  size: number | null;
  containers: number;
  references: { id: string; name: string; state: string }[];
  created: number;
}
export interface CleanupCandidate {
  id: string;
  label: string;
  createdAt?: number | string | null;
  size: number | null;
  eligible: boolean;
  reason: string | null;
}
export interface DiskUsage {
  imagesBytes: number | null;
  containersBytes: number | null;
  volumesBytes: number | null;
  buildCacheBytes: number | null;
  reclaimableBytes: number | null;
  images: CleanupCandidate[];
  buildCache: CleanupCandidate[];
  warnings: string[];
}
export type DestructiveRequest = {
  kind: 'container_delete' | 'image_delete' | 'cleanup';
  ids?: string[];
  imageIds?: string[];
  buildCacheIds?: string[];
};
export interface DestructivePreview {
  token: string;
  kind: DestructiveRequest['kind'];
  targets: string[];
  impact: string[];
  recoverable: false;
  expiresAt: number;
  estimatedBytes: number | null;
}
export interface ActionResult { message: string }
export interface ContainerActionResult extends ActionResult { state: string; exitCode: number | null }
export interface DestructiveResult extends ActionResult {
  deleted: string[];
  failed: { id: string; error: string }[];
}
export interface ContainerLogs { content: string; truncated: boolean }
export interface ContainerMetric {
  id: string; cpuPercent: number | null; memoryUsageBytes: number | null;
  memoryLimitBytes: number | null; memoryPercent: number | null;
  readAt: string | null; cpuReason: string | null; memoryReason: string | null;
}
export interface ContainerMetrics {
  samples: ContainerMetric[]; engineCpuCount: number | null; memoryTotalBytes: number | null; measuredAt: number;
}
export interface WslDisk {
  id: string;
  distribution: string;
  owner: string;
  path: string | null;
  exists: boolean;
  fileSizeBytes: number | null;
  running: boolean | null;
  attached: boolean | null;
  compactionStatus: string;
  blockedReasons: string[];
}
export interface WslInventory {
  status: string;
  disks: WslDisk[];
  runningDistributions: string[];
  admin: boolean;
  diagnostics: string[];
  runtimeProcesses?: string[];
  operation?: DiskOperation | null;
}
export interface WslPreview {
  diskId: string;
  method?: string | null;
  path: string | null;
  eligible: boolean;
  blockedReasons: string[];
  checks: unknown;
  warnings: string[];
  fileSizeBytes: number | null;
  token: string | null;
  expiresAt: number | null;
}
export interface CompactResult {
  status: 'completed';
  diskId: string;
  path: string;
  beforeBytes: number;
  afterBytes: number;
  vhdxReductionBytes: number;
  allocatedBeforeBytes: number;
  allocatedAfterBytes: number;
  reclaimedBytes: number;
  method: string;
  warnings: string[];
}
export type DiskOperation = CompactResult | { status: 'in_progress'; diskId: string; startedAt?: number; warnings: string[] } | { status: 'failed'; diskId: string; error: string; warnings: string[] };

export async function backend<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (command === 'image_search') {
    const term = typeof args?.term === 'string' ? args.term.trim() : '';
    const parts = term.split('/');
    if (!term || term.length > 128 || !/^[A-Za-z0-9/_.-]+$/.test(term) || term.includes('..')
      || parts.some(part => !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(part))
      || (parts.length > 1 && parts[0].includes('.'))) {
      throw new Error('Docker Hub 검색어는 1~128자의 영문, 숫자, /, _, ., -로 입력하세요. 외부 레지스트리 주소는 검색할 수 없습니다.');
    }
    args = { ...args, term };
  }
  if (!('__TAURI_INTERNALS__' in window)) throw new Error('데스크톱 백엔드에 연결할 수 없습니다. DockSlate Windows 앱에서 실행하세요.');
  return invoke<T>(command, args);
}

const dashboardCommands = ['engine_status', 'overview', 'containers_list', 'images_list', 'disk_usage', 'runtime_status', 'wsl_inventory', 'volumes_list', 'networks_list', 'installer_setup_mode'];
const queryCommands = [...dashboardCommands, 'builds_snapshot'];
const buildsIndex = dashboardCommands.length;
type CommandResult = { Ok?: unknown; Err?: string };
type QueryState = { data: unknown; loading: boolean; error: string | null; revision: number };
const emptyQuery: QueryState = { data: null, loading: false, error: null, revision: 0 };
const queries: QueryState[] = queryCommands.map(() => ({ ...emptyQuery, loading: true }));
const versions = new Uint32Array(queryCommands.length);
const requests: (Promise<void> | undefined)[] = new Array(queryCommands.length);
const listeners: (() => void)[][] = queryCommands.map(() => []);
let initialized = false, revision = 0;
let dashboardRequest: Promise<void> | null = null;
let metricsGeneration = 0;
function subscribe(list: (() => void)[], listener: () => void) {
  list.push(listener);
  return () => { const index = list.indexOf(listener); if (index >= 0) list.splice(index, 1); };
}
function publish(index: number, value: QueryState) {
  const previous = queries[index];
  if (previous.data === value.data && previous.loading === value.loading && previous.error === value.error && previous.revision === value.revision) return;
  queries[index] = value;
  for (const listener of [...listeners[index]]) listener();
}
const idleSubscribe = () => () => {};
const metricListeners: (() => void)[] = [];
let metricState: { data: ContainerMetrics | null; loading: boolean; error: string | null } = { data: null, loading: false, error: null };
const subscribeMetrics = (listener: () => void) => subscribe(metricListeners, listener);
const getMetrics = () => metricState;
function publishMetrics(value: typeof metricState) {
  metricState = value;
  for (const listener of [...metricListeners]) listener();
}
export function useContainerMetrics() { return useSyncExternalStore(subscribeMetrics, getMetrics, getMetrics); }

let metricPending: { containers: Container[]; generation: number } | null = null;
let metricRunning = false;
async function measureContainers(containers: Container[], connected: boolean, generation: number) {
  if (!connected) { metricPending = null; publishMetrics({ data: null, loading: false, error: null }); return; }
  metricPending = { containers, generation };
  publishMetrics({ ...metricState, loading: true, error: null });
  if (metricRunning) return;
  metricRunning = true;
  try {
    while (metricPending) {
      const job = metricPending; metricPending = null;
      const ids: string[] = [];
      for (const container of job.containers) if (['running', 'paused', 'restarting'].includes(container.state)) ids.push(container.id);
      const samples: ContainerMetric[] = [];
      try {
        for (let offset = 0; offset < Math.max(ids.length, 1); offset += 16) {
          if (job.generation !== metricsGeneration) break;
          const part = await backend<ContainerMetrics>('containers_metrics', { ids: ids.slice(offset, offset + 16) });
          if (job.generation !== metricsGeneration) break;
          samples.push(...part.samples);
          publishMetrics({ data: { ...part, samples: [...samples] }, loading: offset + 16 < ids.length, error: null });
        }
      } catch (failure) {
        if (job.generation === metricsGeneration) publishMetrics({ ...metricState, loading: false, error: errorMessage(failure) });
      }
    }
  } finally { metricRunning = false; }
}
let buildsPending: number | null = null;
let buildsRunning = false;
async function refreshBuilds(generation: number) {
  buildsPending = generation;
  publish(buildsIndex, { ...queries[buildsIndex], loading: true });
  if (buildsRunning) return;
  buildsRunning = true;
  try {
    while (buildsPending !== null) {
      const current = buildsPending; buildsPending = null;
      try {
        const data = await backend('builds_snapshot');
        if (current === metricsGeneration) publish(buildsIndex, { data, error: null, loading: false, revision });
      } catch (failure) {
        if (current === metricsGeneration) publish(buildsIndex, { ...queries[buildsIndex], error: errorMessage(failure), loading: false, revision });
      }
    }
  } finally { buildsRunning = false; }
}

export function updateContainerStatus(id: string, state: string) {
  const rows = (queries[2].data as Container[] | null)?.map(row => row.id === id ? { ...row, state, status: state } : row);
  if (!rows) return;
  publish(2, { ...queries[2], data: rows });
  const overview = queries[1].data as OverviewData | null;
  if (overview) {
    let running = 0, stopped = 0;
    for (const row of rows) { if (row.state === 'running') running++; else if (['exited','created','dead'].includes(row.state)) stopped++; }
    publish(1, { ...queries[1], data: { ...overview, containersRunning: running, containersStopped: stopped } });
  }
}

export function refreshDashboard(): Promise<void> {
  if (dashboardRequest) return dashboardRequest;
  const generation = ++metricsGeneration;
  for (let index = 0; index < queryCommands.length; index++) {
    versions[index]++;
    publish(index, { ...queries[index], loading: true, error: null });
  }
  void refreshBuilds(generation);
  dashboardRequest = (async () => {
    try {
      const snapshot = await backend<Record<string, CommandResult>>('dashboard_snapshot');
      revision++;
      for (let index = 0; index < dashboardCommands.length; index++) {
        const result = snapshot[dashboardCommands[index]];
        const error = !result || result.Err !== undefined || !Object.prototype.hasOwnProperty.call(result, 'Ok') ? result?.Err ?? '전체 조회 결과에 이 항목이 없습니다.' : null;
        publish(index, { data: error ? queries[index].data : result!.Ok, error, loading: false, revision });
      }
      initialized = true;
      if (!queries[buildsIndex].loading) publish(buildsIndex, { ...queries[buildsIndex], revision });
      if (!queries[0].error && !queries[2].error) void measureContainers((queries[2].data as Container[]) ?? [], (queries[0].data as EngineStatus | null)?.state === 'connected', generation);
      else publishMetrics({ ...metricState, loading: false, error: queries[0].error ?? queries[2].error });
    } catch (failure) {
      const error = errorMessage(failure);
      for (let index = 0; index < dashboardCommands.length; index++) publish(index, { ...queries[index], loading: false, error });
      initialized = true;
      publishMetrics({ ...metricState, loading: false, error });
    } finally { dashboardRequest = null; }
  })();
  return dashboardRequest;
}

export async function refreshDashboardAfterMutation(): Promise<void> {
  if (dashboardRequest) await dashboardRequest;
  await refreshDashboard();
}
async function pollDashboardCommand(index: number): Promise<void> {
  if (dashboardRequest) return dashboardRequest;
  if (requests[index]) return requests[index];
  versions[index] = (versions[index] + 1) >>> 0;
  const version = versions[index];
  const request = (async () => {
    try {
      const data = await backend(queryCommands[index]);
      if (versions[index] === version) publish(index, { ...queries[index], data, error: null });
    } catch (failure) {
      if (versions[index] === version) publish(index, { ...queries[index], error: errorMessage(failure) });
    } finally { requests[index] = undefined; }
  })();
  requests[index] = request;
  return request;
}

export function useBackendQuery<T>(command: string, args: Record<string, unknown> | undefined = undefined, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const generation = useRef(0);
  const argsKey = JSON.stringify(args ?? {});
  const index = argsKey === '{}' ? queryCommands.indexOf(command) : -1;
  const getSnapshot = useCallback(() => index >= 0 ? queries[index] : emptyQuery, [index]);
  const subscribeQuery = useCallback((listener: () => void) => index >= 0 ? subscribe(listeners[index], listener) : idleSubscribe(), [index]);
  const snapshot = useSyncExternalStore(subscribeQuery, getSnapshot, getSnapshot);
  const reload = useCallback(async () => {
    if (index >= 0) return refreshDashboard();
    const current = ++generation.current;
    if (!enabled) { setData(null); setError(null); setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const value = await backend<T>(command, JSON.parse(argsKey) as Record<string, unknown>);
      if (current === generation.current) setData(value);
    } catch (failure) {
      if (current === generation.current) { setError(errorMessage(failure)); setData(null); }
    } finally { if (current === generation.current) setLoading(false); }
  }, [command, argsKey, enabled, index]);
  const poll = useCallback(async () => {
    if (index < 0) return reload();
    setPolling(true);
    try { await pollDashboardCommand(index); }
    finally { setPolling(false); }
  }, [index, reload]);
  useEffect(() => {
    if (index >= 0) { if (!initialized) void refreshDashboard(); }
    else void reload();
    return () => { generation.current += 1; };
  }, [reload, index]);
  return index >= 0
    ? { data: enabled ? snapshot.data as T | null : null, loading: snapshot.loading || polling, error: enabled ? snapshot.error : null, reload, poll, revision: snapshot.revision }
    : { data, loading, error, reload, poll, revision: 0 };
}
