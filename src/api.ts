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
  composeProject: string | null;
}
export interface DockerImage {
  id: string;
  tags: string[];
  size: number | null;
  containers: number;
  created: number;
}
export interface CleanupCandidate {
  id: string;
  label: string;
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
export interface DestructiveResult extends ActionResult {
  deleted: string[];
  failed: { id: string; error: string }[];
}
export interface ContainerLogs { content: string; truncated: boolean }
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
  if (!('__TAURI_INTERNALS__' in window)) throw new Error('데스크톱 백엔드에 연결할 수 없습니다. DockSlate Windows 앱에서 실행하세요.');
  return invoke<T>(command, args);
}

const dashboardCommands = new Set(['engine_status', 'overview', 'containers_list', 'images_list', 'disk_usage', 'runtime_status', 'wsl_inventory']);
type CommandResult = { Ok?: unknown; Err?: string };
type DashboardState = { values: Record<string, unknown>; errors: Record<string, string>; loading: boolean; initialized: boolean; revision: number };
let dashboard: DashboardState = { values: {}, errors: {}, loading: true, initialized: false, revision: 0 };
let dashboardRequest: Promise<void> | null = null;
const dashboardListeners = new Set<() => void>();
const commandVersions = new Map<string, number>();
const commandRequests = new Map<string, Promise<void>>();
const subscribeDashboard = (listener: () => void) => { dashboardListeners.add(listener); return () => { dashboardListeners.delete(listener); }; };
const getDashboard = () => dashboard;
function publishDashboard(value: DashboardState) { dashboard = value; dashboardListeners.forEach(listener => listener()); }

export function refreshDashboard(): Promise<void> {
  if (dashboardRequest) return dashboardRequest;
  dashboardCommands.forEach(command => commandVersions.set(command, (commandVersions.get(command) ?? 0) + 1));
  publishDashboard({ ...dashboard, loading: true, errors: {} });
  dashboardRequest = (async () => {
    try {
      const snapshot = await backend<Record<string, CommandResult>>('dashboard_snapshot');
      const values = { ...dashboard.values };
      const errors: Record<string, string> = {};
      dashboardCommands.forEach(command => {
        const result = snapshot[command];
        if (!result || result.Err !== undefined || !Object.prototype.hasOwnProperty.call(result, 'Ok')) errors[command] = result?.Err ?? '전체 조회 결과에 이 항목이 없습니다.';
        else values[command] = result.Ok;
      });
      publishDashboard({ values, errors, loading: false, initialized: true, revision: dashboard.revision + 1 });
    } catch (failure) {
      const message = errorMessage(failure);
      publishDashboard({ ...dashboard, errors: Object.fromEntries([...dashboardCommands].map(command => [command, message])), loading: false, initialized: true });
    } finally { dashboardRequest = null; }
  })();
  return dashboardRequest;
}

export async function refreshDashboardAfterMutation(): Promise<void> {
  if (dashboardRequest) await dashboardRequest;
  await refreshDashboard();
}

async function pollDashboardCommand(command: string): Promise<void> {
  if (dashboardRequest) return dashboardRequest;
  const existing = commandRequests.get(command);
  if (existing) return existing;
  const version = (commandVersions.get(command) ?? 0) + 1;
  commandVersions.set(command, version);
  const request = (async () => {
    try {
      const value = await backend(command);
      if (commandVersions.get(command) !== version) return;
      const errors = { ...dashboard.errors };
      delete errors[command];
      publishDashboard({ ...dashboard, values: { ...dashboard.values, [command]: value }, errors });
    } catch (failure) {
      if (commandVersions.get(command) === version) publishDashboard({ ...dashboard, errors: { ...dashboard.errors, [command]: errorMessage(failure) } });
    } finally { commandRequests.delete(command); }
  })();
  commandRequests.set(command, request);
  return request;
}

export function useBackendQuery<T>(command: string, args: Record<string, unknown> | undefined = undefined, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const generation = useRef(0);
  const argsKey = JSON.stringify(args ?? {});
  const shared = dashboardCommands.has(command) && argsKey === '{}';
  const snapshot = useSyncExternalStore(subscribeDashboard, getDashboard, getDashboard);
  const reload = useCallback(async () => {
    if (shared) return refreshDashboard();
    const current = ++generation.current;
    if (!enabled) { setData(null); setError(null); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const queryArgs = JSON.parse(argsKey) as Record<string, unknown>;
      const value = await backend<T>(command, queryArgs);
      if (current === generation.current) setData(value);
    } catch (failure) {
      if (current === generation.current) { setError(errorMessage(failure)); setData(null); }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [command, argsKey, enabled, shared]);
  const poll = useCallback(async () => {
    if (!shared) return reload();
    setPolling(true);
    try { await pollDashboardCommand(command); }
    finally { setPolling(false); }
  }, [command, shared, reload]);
  useEffect(() => {
    if (shared) { if (!dashboard.initialized) void refreshDashboard(); }
    else void reload();
    return () => { generation.current += 1; };
  }, [reload, shared]);
  return shared
    ? { data: enabled ? (snapshot.values[command] as T | undefined) ?? null : null, loading: snapshot.loading || polling, error: enabled ? snapshot.errors[command] ?? null : null, reload, poll, revision: snapshot.revision }
    : { data, loading, error, reload, poll, revision: 0 };
}
