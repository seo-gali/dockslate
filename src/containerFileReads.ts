import { backend } from './api';
export type { ContainerDirectory,ContainerFileEntry,ContainerFilePreview } from './ipc/contracts/files';





let activeRequests = 0;
async function read<C extends 'container_files' | 'container_file_preview'>(command: C, id: string, path: string) {
  if (activeRequests >= 12) throw new Error('파일을 읽고 있습니다. 현재 작업을 마친 뒤 다시 시도하세요.');
  activeRequests++;
  try { return await backend(command, { id, path }); }
  finally { activeRequests--; }
}
export const readContainerDirectory = (id: string, path: string) => read('container_files', id, path);
export const readContainerFilePreview = (id: string, path: string) => read('container_file_preview', id, path);
