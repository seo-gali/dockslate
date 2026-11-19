import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { backend } from './ipc/client';
import type { CommandResult } from './ipc/commands';
import type { Container, EngineStatus, OverviewData, ContainerMetrics, ContainerMetric } from './ipc/contracts/core';
import { errorMessage } from './components';

const definitions = [
  ['engine_status', 16], ['overview', 23], ['containers_list', 25], ['images_list', 19],
  ['disk_usage', 23], ['runtime_status', 0], ['wsl_inventory', 0],
  ['volumes_list', 21], ['networks_list', 25], ['installer_setup_mode', 0],
] as const;
const dashboardCommands = definitions.map(([command]) => command);
const queryCommands = [...dashboardCommands, 'builds_snapshot'] as const;
export type QueryCommand = typeof queryCommands[number];
const buildsIndex = dashboardCommands.length;
const engineIndex = queryCommands.indexOf('engine_status');
const overviewIndex = queryCommands.indexOf('overview');
const containersIndex = queryCommands.indexOf('containers_list');

type QueryState = { data: unknown; loading: boolean; error: string | null; revision: number };
const emptyQuery: QueryState = { data: null, loading: false, error: null, revision: 0 };
const queries: QueryState[] = queryCommands.map(() => ({ ...emptyQuery, loading: true }));
const versions = new Uint32Array(queryCommands.length);
const requests: (Promise<void> | undefined)[] = new Array(queryCommands.length);
const listeners: (() => void)[][] = queryCommands.map(() => []);
let initialized = false, revision = 0;
let dashboardRequest: Promise<void> | null = null;
let metricsGeneration = 0;
let dashboardGeneration = 0;
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
          const part = await backend('containers_metrics', { ids: ids.slice(offset, offset + 16) });
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
        if (current === dashboardGeneration) publish(buildsIndex, { data, error: null, loading: false, revision });
      } catch (failure) {
        if (current === dashboardGeneration) publish(buildsIndex, { ...queries[buildsIndex], error: errorMessage(failure), loading: false, revision });
      }
    }
  } finally { buildsRunning = false; }
}

export function updateContainerStatus(id: string, state: string) {
  const rows = (queries[containersIndex].data as Container[] | null)?.map(row => row.id === id ? { ...row, state, status: state } : row);
  if (!rows) return;
  publish(containersIndex, { ...queries[containersIndex], data: rows });
  const overview = queries[overviewIndex].data as OverviewData | null;
  if (overview) {
    let running = 0, stopped = 0;
    for (const row of rows) { if (row.state === 'running') running++; else if (['exited','created','dead'].includes(row.state)) stopped++; }
    publish(overviewIndex, { ...queries[overviewIndex], data: { ...overview, containersRunning: running, containersStopped: stopped } });
  }
}

export function refreshDashboard(): Promise<void> {
  if (dashboardRequest) return dashboardRequest;
  const generation = ++metricsGeneration;
  for (let index = 0; index < queryCommands.length; index++) {
    versions[index]++;
    publish(index, { ...queries[index], loading: true, error: null });
  }
  void refreshBuilds(++dashboardGeneration);
  dashboardRequest = (async () => {
    try {
      const snapshot = await backend('dashboard_snapshot');
      revision++;
      for (let index = 0; index < dashboardCommands.length; index++) {
        const result = snapshot[dashboardCommands[index]];
        const error = !result || result.Err !== undefined || !Object.prototype.hasOwnProperty.call(result, 'Ok') ? result?.Err ?? '전체 조회 결과에 이 항목이 없습니다.' : null;
        publish(index, { data: error ? queries[index].data : result!.Ok, error, loading: false, revision });
      }
      initialized = true;
      if (!queries[buildsIndex].loading) publish(buildsIndex, { ...queries[buildsIndex], revision });
      if (!queries[engineIndex].error && !queries[containersIndex].error) void measureContainers((queries[containersIndex].data as Container[]) ?? [], (queries[engineIndex].data as EngineStatus | null)?.state === 'connected', generation);
      else publishMetrics({ ...metricState, loading: false, error: queries[engineIndex].error ?? queries[containersIndex].error });
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

let pendingChanges = 0;
let eventRequest: Promise<void> | null = null;
export function refreshDockerChanges(mask: number): Promise<void> {
  if (!(mask & 31)) return eventRequest ?? Promise.resolve();
  pendingChanges |= mask & 31;
  if (eventRequest) return eventRequest;
  eventRequest = (async () => {
    try {
      while (pendingChanges) {
        if (dashboardRequest) await dashboardRequest;
        const changes = pendingChanges; pendingChanges = 0;
        const targets = definitions.flatMap(([command, mask], index) => {
          if (mask === 0 || !(mask & changes)) return [];
          return [{ command, index }];
        });
        const expected = targets.map(({ index }) => versions[index] = (versions[index] + 1) >>> 0);
        const generation = changes & 17 ? ++metricsGeneration : metricsGeneration;
        try {
          const snapshot = await backend('docker_events_snapshot');
          const currentRevision = ++revision;
          targets.forEach(({ command, index }, position) => {
            if (versions[index] !== expected[position]) return;
            const result = snapshot[command];
            const error = !result || result.Err !== undefined || !Object.prototype.hasOwnProperty.call(result, 'Ok') ? result?.Err ?? 'Docker 변경 조회 결과에 이 항목이 없습니다.' : null;
            publish(index, { data: error ? queries[index].data : result!.Ok, error, loading: false, revision: currentRevision });
          });
          if (changes & 17 && generation === metricsGeneration) {
            if (!queries[engineIndex].error && !queries[containersIndex].error) void measureContainers((queries[containersIndex].data as Container[]) ?? [], (queries[engineIndex].data as EngineStatus | null)?.state === 'connected', generation);
            else publishMetrics({ ...metricState, loading: false, error: queries[engineIndex].error ?? queries[containersIndex].error });
          }
        } catch (failure) {
          targets.forEach(({ index }, position) => { if (versions[index] === expected[position]) publish(index, { ...queries[index], error: errorMessage(failure) }); });
        }
      }
    } finally { eventRequest = null; }
  })();
  return eventRequest;
}

type DockerEvent = { streamId: string; state: 'ready' | 'changed' | 'reconnecting' | 'closed'; mask: number };
export function useDockerEvents(engine: EngineStatus | null, allowed: boolean) {
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const connected = engine?.state === 'connected';
  const id = engine?.id, api = engine?.apiVersion, owner = engine?.ownerPath;
  useEffect(() => {
    if (!allowed || !connected || !id || !('__TAURI_INTERNALS__' in window)) { setError(false); return; }
    let disposed = false, starting = false;
    let unsubscribe: (() => void) | undefined;
    let reconnectTimer: number | undefined, refreshTimer: number | undefined;
    let changes = 0;
    const streamId = crypto.randomUUID();
    const stopStream = () => { void backend('engine_events_stop', { streamId }).catch(() => undefined); };
    window.addEventListener('pagehide', stopStream);
    const queue = (mask: number) => {
      changes |= mask & 31;
      if (refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => { refreshTimer = undefined; const mask = changes; changes = 0; if (!disposed) void refreshDockerChanges(mask); }, 500);
    };
    const start = async () => {
      if (disposed || starting) return;
      starting = true;
      try { await backend('engine_events_start', { streamId, engineId: id }); if (disposed) stopStream(); }
      catch { if (!disposed) { setError(true); reconnectTimer = window.setTimeout(() => { reconnectTimer = undefined; void start(); }, 3000); } }
      finally { starting = false; }
    };
    void listen<DockerEvent>('docker-engine-events', event => {
      if (disposed || event.payload.streamId !== streamId) return;
      const value = event.payload;
      if (value.state === 'ready') { setError(false); queue(31); }
      else if (value.state === 'changed') queue(value.mask);
      else {
        setError(true);
        if (value.state === 'closed') {
          queue(31);
          if (reconnectTimer === undefined) reconnectTimer = window.setTimeout(() => { reconnectTimer = undefined; void start(); }, 3000);
        }
      }
    }).then(stop => { if (disposed) stop(); else { unsubscribe = stop; void start(); } }).catch(() => { if (!disposed) setError(true); });
    return () => {
      disposed = true; unsubscribe?.(); window.clearTimeout(reconnectTimer); window.clearTimeout(refreshTimer);
      window.removeEventListener('pagehide', stopStream); stopStream();
    };
  }, [allowed, connected, id, api, owner, retry]);
  useEffect(() => {
    const focus = () => { if (allowed && (queries[engineIndex].data as EngineStatus | null)?.ownerPath) void refreshDockerChanges(31); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [allowed]);
  return { error, reconnect: () => setRetry(value => value + 1) };
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

export function useBackendQuery<C extends QueryCommand>(command: C, _args: undefined = undefined, enabled = true) {
  const [polling, setPolling] = useState(false);
  const index = queryCommands.indexOf(command);
  const getSnapshot = useCallback(() => queries[index], [index]);
  const subscribeQuery = useCallback((listener: () => void) => subscribe(listeners[index], listener), [index]);
  const snapshot = useSyncExternalStore(subscribeQuery, getSnapshot, getSnapshot);
  const reload = useCallback(async () => { if (enabled) await refreshDashboard(); }, [enabled]);
  const poll = useCallback(async () => {
    if (!enabled) return;
    setPolling(true);
    try { await pollDashboardCommand(index); } finally { setPolling(false); }
  }, [index, enabled]);
  useEffect(() => { if (enabled && !initialized) void refreshDashboard(); }, [enabled]);
  return { data: enabled ? snapshot.data as CommandResult<C> | null : null, loading: enabled && (snapshot.loading || polling), error: enabled ? snapshot.error : null, reload, poll, revision: snapshot.revision };
}
