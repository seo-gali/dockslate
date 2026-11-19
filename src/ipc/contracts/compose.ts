export interface ImportFileSelection {
  token: string | null;
  kind: 'dockerfile' | 'compose';
  path: string | null;
  contextPath?: string;
  dockerfile?: string;
}

export interface ComposeService {
  name: string;
  image: string;
  build: { contextPath: string; dockerfile: string } | null;
  ports: { target: number; published?: string; host_ip?: string; protocol?: string }[] | null;
  volumes: { type: string; source: string; target: string; read_only?: boolean }[] | null;
  networks: string[];
  environmentKeys: string[];
}

export interface ComposePreview {
  token: string;
  path: string;
  contextPath: string;
  project: string;
  engineId: string;
  hasBuild: boolean;
  contextFingerprint: string;
  services: ComposeService[];
  resources: { kind: string; key: string; name: string }[];
  warnings: string[];
}

export interface ComposeRunPreview extends ComposePreview {
  previewToken: string;
  imageIds: string[];
  expiresInSeconds: number;
  impact: string;
}

export interface ComposeJob {
  id: string;
  operation: 'build' | 'run';
  project: string;
  state: 'running' | 'completed' | 'failed';
  logs: string;
  error?: string | null;
}
