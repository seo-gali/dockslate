export interface EngineStatus {
  state: 'connected' | 'busy' | 'unavailable' | 'unsupported' | 'permission_denied';
  context: string | null;
  endpoint: string | null;
  engine: string | null;
  serverVersion: string | null;
  apiVersion: string | null;
  ownerPath: string | null;
  id?: string;
  os?: string;
  kernel?: string;
  architecture?: string;
  storageDriver?: string;
  cpuCount?: number;
  memoryTotalBytes?: number;
  dockerRootDir?: string;
  appVersion?: string;
  message: string;
}
export interface OverviewData {
  engine: EngineStatus;
  containersRunning: number | null;
  containersStopped: number | null;
  images: number | null;
  dockerBytes: number | null;
  reclaimableBytes: number | null;
}
export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  publishedPorts?: { privatePort: number; publicPort: number; protocol: string; ip: string }[];
  composeProject: string | null;
}
export interface DockerImage {
  id: string;
  tags: string[];
  size: number | null;
  containers: number;
  references: { id: string; name: string; state: string }[];
  created: number;
}
export interface CleanupCandidate {
  id: string;
  label: string;
  createdAt?: number | string | null;
  size: number | null;
  eligible: boolean;
  reason: string | null;
}
export interface DiskUsage {
  imagesBytes: number | null;
  containersBytes: number | null;
  volumesBytes: number | null;
  buildCacheBytes: number | null;
  reclaimableBytes: number | null;
  images: CleanupCandidate[];
  buildCache: CleanupCandidate[];
  warnings: string[];
}
export type DestructiveRequest = {
  kind: 'container_delete' | 'image_delete' | 'cleanup';
  ids?: string[];
  imageIds?: string[];
  buildCacheIds?: string[];
};
export interface DestructivePreview {
  token: string;
  kind: DestructiveRequest['kind'];
  targets: string[];
  impact: string[];
  recoverable: false;
  expiresAt: number;
  estimatedBytes: number | null;
}
export interface ActionResult { message: string }
export interface ContainerActionResult extends ActionResult { state: string; exitCode: number | null }
export interface ContainerBatchResult { results: { id: string; name: string; outcome: 'completed' | 'skipped' | 'failed'; state?: string; exitCode?: number | null; error?: string }[] }
export interface DestructiveResult extends ActionResult {
  deleted: string[];
  failed: { id: string; error: string }[];
}
export interface ContainerLogs { content: string; truncated: boolean }
export interface ContainerMetric {
  id: string; cpuPercent: number | null; memoryUsageBytes: number | null;
  memoryLimitBytes: number | null; memoryPercent: number | null;
  readAt: string | null; cpuReason: string | null; memoryReason: string | null;
}
export interface ContainerMetrics {
  samples: ContainerMetric[]; engineCpuCount: number | null; memoryTotalBytes: number | null; measuredAt: number;
}
export interface WslDisk {
  id: string;
  distribution: string;
  owner: string;
  path: string | null;
  exists: boolean;
  fileSizeBytes: number | null;
  running: boolean | null;
  attached: boolean | null;
  compactionStatus: string;
  blockedReasons: string[];
}
export interface WslInventory {
  status: string;
  disks: WslDisk[];
  runningDistributions: string[];
  admin: boolean;
  diagnostics: string[];
  runtimeProcesses?: string[];
  operation?: DiskOperation | null;
}
export interface WslPreview {
  diskId: string;
  method?: string | null;
  path: string | null;
  eligible: boolean;
  blockedReasons: string[];
  checks: unknown;
  warnings: string[];
  fileSizeBytes: number | null;
  token: string | null;
  expiresAt: number | null;
}
export interface CompactResult {
  status: 'completed';
  diskId: string;
  path: string;
  beforeBytes: number;
  afterBytes: number;
  vhdxReductionBytes: number;
  allocatedBeforeBytes: number;
  allocatedAfterBytes: number;
  reclaimedBytes: number;
  method: string;
  warnings: string[];
}
export type DiskOperation = CompactResult | { status: 'in_progress'; diskId: string; startedAt?: number; warnings: string[] } | { status: 'failed'; diskId: string; error: string; warnings: string[] };
