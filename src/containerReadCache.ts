import { backend, type ContainerLogs } from './api';
type LogEntry = { data: ContainerLogs; revision: number; readAt: number };
const logs = new Map<string, LogEntry>();
const pending = new Map<string, Promise<LogEntry>>();
export const cachedLogs = (id: string) => logs.get(id);
export function readContainerLogs(id: string, revision: number, force = false): Promise<LogEntry> {
  const cached = logs.get(id);
  if (!force && cached?.revision === revision) return Promise.resolve(cached);
  const key = `${id}:${revision}`, current = pending.get(key);
  if (current) return current;
  const request = backend<ContainerLogs>('container_logs', { id }).then(data => {
    const entry = { data, revision, readAt: Date.now() };
    logs.delete(id); logs.set(id, entry);
    while (logs.size > 16) logs.delete(logs.keys().next().value!);
    return entry;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
