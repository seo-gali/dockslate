export interface Selection { images: string[]; containers: string[]; volumes: string[]; stopRunning: boolean; startAfterImport: boolean }
export interface Item { id: string; name: string; detail: string; project?: string | null; image?: string; volumes?: string[] }
export interface Inventory { sourceEngine: string; targetEngine: string; images: Item[]; containers: Item[]; volumes: Item[] }
export interface Preview {
  token: string; expiresAt: number; eligible: boolean; blockedReasons: string[];
  sourceEngine: string; targetEngine: string;
  images: string[]; containers: string[]; volumes: string[]; networks: string[];
  stopContainers: string[]; startContainers: string[];
  binds: { source: string; volume: string }[]; dockerSocketContainers: string[];
  reusedNetworks: string[];
  reusedVolumes: string[];
}
export interface Job {
  id: string; kind: 'inventory' | 'preview' | 'transfer'; state: 'running' | 'completed' | 'failed'; message: string;
  completed: string[]; warnings: string[]; error?: string;
  stoppedSources?: string[]; startedTargets?: string[];
  inventory?: Inventory; preview?: Preview;
  progress?: { phase: string; completed: number; total: number };
  imported?: { kind: 'containers' | 'volumes' | 'images'; id: string }[];
}
