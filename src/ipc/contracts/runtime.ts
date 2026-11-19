export type RuntimeState = 'not_installed' | 'stopped' | 'running' | 'installing' | 'starting' | 'stopping' | 'failed' | 'unsupported';

export interface RuntimeStatus {
  state: RuntimeState;
  distribution: string;
  installPath: string | null;
  message: string;
  blockedReasons: string[];
  retryableInstallation: boolean;
  operation?: { state: string; message: string; processId?: number; startedAt?: number } | null;
}

export interface RuntimeInstallPreview {
  token: string | null;
  targets: string[];
  impact: string[];
  requirements: string[];
  eligible: boolean;
  retryableInstallation: boolean;
  blockedReasons: string[];
  expiresAt: number | null;
}

export interface RuntimeResult { state: RuntimeState; message: string }

export interface StartupSettings {
  startEngine: boolean;
  startApp: boolean;
  conflict: boolean;
  executable: string;
  autoStartAllowed: boolean;
}
