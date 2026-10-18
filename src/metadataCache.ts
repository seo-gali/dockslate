import { backend } from './api';

const values = new Map<string, { data: unknown; bytes: number }>();
const pending = new Map<string, Promise<unknown>>();
let bytes = 0;
export function readMetadata<T>(command: 'container_inspect' | 'image_details', id: string, revision: number): Promise<T> {
  const key = `${command}:${id}:${revision}`;
  const cached = values.get(key);
  if (cached) { values.delete(key); values.set(key, cached); return Promise.resolve(cached.data as T); }
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const request = backend<T>(command, { id }).then(data => {
    const weight = JSON.stringify(data).length * 2;
    if (weight <= 2 * 1024 * 1024) {
      values.set(key, { data, bytes: weight }); bytes += weight;
      while (bytes > 8 * 1024 * 1024 || values.size > 24) {
        const first = values.keys().next().value!;
        bytes -= values.get(first)!.bytes; values.delete(first);
      }
    }
    return data;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
