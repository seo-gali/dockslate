import { backend } from './api';

export type ContainerFileEntry = Readonly<{ name: string; path: string; kind: 'directory' | 'file' | 'symlink' | 'other'; size: number | null; modifiedAt: number | null }>;
export type ContainerDirectory = Readonly<{ path: string; entries: readonly ContainerFileEntry[]; truncated: boolean }>;
export type ContainerFilePreview = Readonly<{ path: string; content: string; binary: boolean; truncated: boolean; bytes: number }>;

let activeRequests = 0;
async function read<T>(command: string, id: string, path: string): Promise<T> {
  if (activeRequests >= 12) throw new Error('파일을 읽고 있습니다. 현재 작업을 마친 뒤 다시 시도하세요.');
  activeRequests++;
  try { return await backend<T>(command, { id, path }); }
  finally { activeRequests--; }
}
export const readContainerDirectory = (id: string, path: string) => read<ContainerDirectory>('container_files', id, path);
export const readContainerFilePreview = (id: string, path: string) => read<ContainerFilePreview>('container_file_preview', id, path);
