export interface Selection { images: string[]; containers: string[]; volumes: string[] }
export interface Item { id: string; name: string; detail: string }
export interface Inventory { sourceEngine: string; targetEngine: string; images: Item[]; containers: Item[]; volumes: Item[] }
export interface Preview {
  token: string; expiresAt: number; eligible: boolean; blockedReasons: string[];
  sourceEngine: string; targetEngine: string;
  images: string[]; containers: string[]; volumes: string[]; networks: string[];
}
export interface Job {
  id: string; state: 'running' | 'completed' | 'failed'; message: string;
  completed: string[]; warnings: string[]; error?: string;
}
