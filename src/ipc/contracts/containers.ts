export interface Source { settings: Settings; state: string; recreateBlockedReason: string | null; fixedMounts: { kind: string; source: string; target: string; readOnly: boolean }[] }

export interface Settings { id: string; name: string; ports: Port[]; mounts: Mount[]; networks: string[] }

export interface Port { containerPort: number; hostPort: number; protocol: string; hostIp: string }

export interface Mount { name: string; target: string; readOnly: boolean }

export interface Preview { token: string; expiresAt: number; before: Settings; after: Settings; recreate: boolean; wasRunning: boolean }

export interface Result { id: string; name: string; message: string; retainedContainer?: string | null; savedImage?: string }
