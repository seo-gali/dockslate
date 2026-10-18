import { backend } from './api';

export type ContainerFileEntry = Readonly<{ name: string; path: string; kind: 'directory' | 'file' | 'symlink' | 'other'; size: number | null; modifiedAt: number | null }>;
export type ContainerDirectory = Readonly<{ path: string; entries: readonly ContainerFileEntry[]; truncated: boolean }>;
export type ContainerFilePreview = Readonly<{ path: string; content: string; binary: boolean; truncated: boolean; bytes: number }>;
type Cached<T> = { value: T; weight: number };
type Bucket = {
  revision: number;
  path: string;
  directories: Map<string, Cached<ContainerDirectory>>;
  previews: Map<string, Cached<ContainerFilePreview>>;
  pending: Map<string, Promise<ContainerDirectory | ContainerFilePreview>>;
  versions: Map<string, number>;
  sequence: number;
};
const containers = new Map<string, Bucket>();
const MAX_CONTAINERS = 8;
const MAX_DIRECTORIES = 64;
const MAX_PREVIEWS = 8;
const MAX_WEIGHT = 12 * 1024 * 1024;
const MAX_REQUESTS = 12;
let activeRequests = 0;

function bucket(id: string, revision: number): Bucket {
  const previous = containers.get(id);
  const value = previous?.revision === revision ? previous : { revision, path: '/', directories: new Map(), previews: new Map(), pending: new Map(), versions: new Map(), sequence: 0 };
  containers.delete(id); containers.set(id, value);
  while (containers.size > MAX_CONTAINERS) containers.delete(containers.keys().next().value!);
  return value;
}
function trim() {
  let weight = 0;
  for (const value of containers.values()) {
    while (value.directories.size > MAX_DIRECTORIES) value.directories.delete(value.directories.keys().next().value!);
    while (value.previews.size > MAX_PREVIEWS) value.previews.delete(value.previews.keys().next().value!);
    for (const entry of [...value.directories.values(), ...value.previews.values()]) weight += entry.weight;
  }
  while (weight > MAX_WEIGHT) {
    let removed = false;
    for (const value of containers.values()) {
      const map = value.previews.size ? value.previews : value.directories;
      const key = map.keys().next().value;
      if (key === undefined) continue;
      weight -= map.get(key)!.weight; map.delete(key); removed = true; break;
    }
    if (!removed) break;
  }
}
export function cachedContainerFiles(id: string, revision: number) {
  const value = containers.get(id);
  return value?.revision === revision ? { path: value.path, directories: new Map([...value.directories].map(([path, entry]) => [path, entry.value])) } : { path: '/', directories: new Map<string, ContainerDirectory>() };
}
export function rememberContainerDirectory(id: string, revision: number, path: string) {
  const value = containers.get(id);
  if (value?.revision === revision) value.path = path;
}

function read<T extends ContainerDirectory | ContainerFilePreview>(id: string, revision: number, path: string, kind: 'directory' | 'preview', force: boolean): Promise<T> {
  const value = bucket(id, revision);
  const values = (kind === 'directory' ? value.directories : value.previews) as Map<string, Cached<T>>;
  const key = `${kind}:${path}`;
  if (!force) {
    const cached = values.get(path);
    if (cached) { values.delete(path); values.set(path, cached); return Promise.resolve(cached.value); }
    const pending = value.pending.get(key);
    if (pending) return pending as Promise<T>;
  }
  if (activeRequests >= MAX_REQUESTS) return Promise.reject(new Error('파일을 읽고 있습니다. 현재 작업을 마친 뒤 다시 시도하세요.'));
  if (force) values.delete(path);
  if (force && kind === 'directory') {
    const prefix = path === '/' ? '/' : `${path}/`;
    for (const previewPath of value.previews.keys()) if (previewPath.startsWith(prefix)) value.previews.delete(previewPath);
    for (const pendingKey of value.pending.keys()) if (pendingKey.startsWith(`preview:${prefix}`)) { value.pending.delete(pendingKey); value.versions.delete(pendingKey); }
  }
  const version = ++value.sequence;
  value.versions.set(key, version);
  activeRequests++;
  const request = backend<T>(kind === 'directory' ? 'container_files' : 'container_file_preview', { id, path }).then(result => {
    const immutable = (kind === 'directory'
      ? Object.freeze({ ...result, entries: Object.freeze((result as ContainerDirectory).entries.map(entry => Object.freeze({ ...entry }))) })
      : Object.freeze({ ...result })) as T;
    if (containers.get(id) === value && value.versions.get(key) === version) {
      const weight = kind === 'directory'
        ? 128 + (immutable as ContainerDirectory).entries.reduce((total, entry) => total + 128 + (entry.name.length + entry.path.length) * 2, path.length * 2)
        : 128 + ((immutable as ContainerFilePreview).content.length + path.length) * 2;
      values.delete(path); values.set(path, { value: immutable, weight }); trim();
    }
    return immutable;
  }).finally(() => {
    activeRequests--;
    if (value.pending.get(key) === request) { value.pending.delete(key); value.versions.delete(key); }
  });
  value.pending.set(key, request);
  return request;
}
export const readContainerDirectory = (id: string, revision: number, path: string, force = false) => read<ContainerDirectory>(id, revision, path, 'directory', force);
export const readContainerFilePreview = (id: string, revision: number, path: string, force = false) => read<ContainerFilePreview>(id, revision, path, 'preview', force);
