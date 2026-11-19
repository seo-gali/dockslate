export interface Network {
  id: string; name: string; driver: string; scope: string; internal: boolean; builtin: boolean;
  ipam: { Driver?: string; Options?: Record<string, string> | null; Config?: { Subnet?: string; Gateway?: string; IPRange?: string; AuxiliaryAddresses?: Record<string, string> }[] | null } | null;
  containers: NetworkContainer[]; deletable: boolean; deleteBlockedReason: string | null;
}

export interface NetworkContainer { id: string; name: string; state: string }

export interface NetworkPreview { token: string; expiresAt: number; network: Network }

export interface DockerVolume {
  name: string; driver: string; scope: string; mountpoint: string; createdAt: string | null;
  labels: Record<string, string> | null; options: Record<string, string> | null;
  referenceCount: number; activeReferences: number; containers: VolumeReference[];
  sizeBytes: number | null; fileSupported: boolean;
}

export interface VolumeReference { id: string; name: string; state: string }

export interface VolumeJob { id: string; kind: string; name: string; destination?: string; state: 'running' | 'completed' | 'failed'; entries: number; bytes: number; error?: string; result?: { message?: string; path?: string; bytes?: number; entries?: number } }

export interface Directory { path: string; entries: DirectoryEntry[] }

export interface DirectoryEntry { name: string; kind: 'directory' | 'file' | 'unsupported'; size: number; modified: number }

export interface FilePreview { path: string; text: string; truncated: boolean; limitBytes: number }

export interface ArchiveSelection { cancelled: boolean; token?: string; path?: string; sizeBytes?: number }

export interface VolumePreview {
  name: string; kind: 'delete' | 'empty' | 'import'; eligible: boolean; token: string | null; expiresAt: number | null;
  mode: 'merge' | 'replace' | null;
  importPlan: { overwrittenFiles: number; overwrittenPaths: string[]; overwrittenPathsTruncated: boolean; createdFiles: number; removedEntries: number; removedBytes: number; preservedEntries: number } | null;
  references: VolumeReference[]; blockedReasons: string[]; summary: { entries: number; bytes: number } | null;
  archive: { path: string; entries: number; bytes: number } | null; impact: string; warnings: string[];
}
