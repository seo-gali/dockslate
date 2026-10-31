import type { ContainerLogs } from './api';
type LogEntry = { data: ContainerLogs; revision: number; readAt: number };
const logs = new Map<string, LogEntry>();
export const cachedLogs = (id: string) => logs.get(id);
export function storeContainerLogs(id: string, revision: number, data: ContainerLogs): LogEntry {
  const entry = {data, revision, readAt: Date.now()};
  logs.delete(id); logs.set(id, entry);
  while (logs.size > 16) logs.delete(logs.keys().next().value!);
  return entry;
}
