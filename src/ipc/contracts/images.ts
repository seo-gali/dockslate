import type { DestructiveResult } from './core';

export interface Details { id: string; tags: string[]; exposedPorts: string[]; entrypoint: string[]; command: string[] }

export interface RunResult { id: string; name: string; state: string; started: boolean; message: string }

export interface RunOptions {
  env?: string[]; command?: string[]; entrypoint?: string[]; workingDir?: string;
  restartPolicy?: string; networkId?: string | null; memoryBytes?: number | null; nanoCpus?: number | null;
  mounts?: { name: string; target: string; readOnly: boolean }[];
}

export interface ImageBuildStatus {
  id: string;
  state: 'running' | 'completed' | 'failed';
  contextPath: string;
  dockerfile: string;
  tag: string;
  logs: string | null;
  logVersion?: number;
  truncated: boolean;
  error?: string | null;
  imageId?: string | null;
  builder?: string | null;
}

export interface ImagePreview {
  token: string | null; eligible: boolean; blockedReasons: string[]; expiresAt: number | null;
  image: { id: string; tags: string[]; size: number | null };
  containers: { id: string; name: string; state: string }[];
  deleteReferencingContainers: boolean;
}

export interface ImageRemovalResult extends DestructiveResult { remaining: string[] }

export interface RegistryImage {
  name: string;
  description: string;
  starCount: number;
  isOfficial: boolean;
}
