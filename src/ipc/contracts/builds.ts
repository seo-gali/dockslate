export interface BuildRecord { id?: string; ref: string; name: string; status: string; createdAt: string | null; completedAt: string | null; totalSteps: number | null; cachedSteps: number | null; source?: string }

export interface BuilderNode { name: string; endpoint: string; status: string | number | null; version: string | null; platforms: string[]; error?: string | null }

export interface Builder { name: string; driver: string; current: boolean; nodes: BuilderNode[]; platforms: string[]; error?: string | null; lastActivity?: string | null }

export interface History { builder: string; state: 'ready' | 'unsupported' | 'error' | 'unavailable'; records: BuildRecord[]; message: string }

export interface Transfer { id: string; state: 'running' | 'completed' | 'failed'; kind: string; path: string; message: string }

export interface Snapshot { version: string; selectedBuilder: string; selectionError?: string | null; builders: Builder[]; history: History; imported: BuildRecord[]; transfer: Transfer | null }

export interface RecordDetail { details: Record<string, unknown>; logs: string; truncated: boolean; source?: string }

export interface BuilderRequest { action: 'create' | 'use' | 'remove' | 'update'; name: string; driver?: string; endpoint?: string; platforms?: string[]; node?: string }

export interface TransferRequest { kind: 'import' | 'export'; path: string; builder?: string; reference?: string; importedId?: string }
