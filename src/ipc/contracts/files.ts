export type ContainerFileEntry = Readonly<{ name: string; path: string; kind: 'directory' | 'file' | 'symlink' | 'other'; size: number | null; modifiedAt: number | null }>;

export type ContainerDirectory = Readonly<{ path: string; entries: readonly ContainerFileEntry[]; truncated: boolean }>;

export type ContainerFilePreview = Readonly<{ path: string; content: string; binary: boolean; truncated: boolean; bytes: number }>;
