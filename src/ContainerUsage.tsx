import { useMemo } from 'react';
import { type Container, type ContainerMetric, useContainerMetrics } from './api';
import { formatBytes } from './components';
import { t } from "./i18n";


export function metricText(sample: ContainerMetric | undefined, running: boolean) {
  return {
    cpu: !running ? t("중지됨") : sample?.cpuPercent == null ? t("미확인") : `${sample.cpuPercent.toFixed(2)}%`,
    memory: !running ? t("중지됨") : sample?.memoryUsageBytes == null ? t("미확인") : formatBytes(sample.memoryUsageBytes),
    memoryPercent: !running || sample?.memoryPercent == null ? '' : `${sample.memoryPercent.toFixed(1)}%`,
  };
}
export function ContainerUsage({ containers }: { containers: Container[] }) {
  const metrics = useContainerMetrics();
  const running = containers.filter(container => ['running', 'paused', 'restarting'].includes(container.state));
  const byId = useMemo(() => new Map(metrics.data?.samples.map(sample => [sample.id, sample]) ?? []), [metrics.data]);
  const samples = running.map(container => byId.get(container.id));
  const cpu = samples.every(sample => sample?.cpuPercent != null) ? samples.reduce((sum, sample) => sum + sample!.cpuPercent!, 0) : null;
  const memory = samples.every(sample => sample?.memoryUsageBytes != null) ? samples.reduce((sum, sample) => sum + sample!.memoryUsageBytes!, 0) : null;
  return <div className="container-usage" aria-label={t("컨테이너 사용량")}><div><span className="muted">{t("컨테이너 CPU")}</span><strong>{cpu === null ? t("미확인") : `${cpu.toFixed(2)}%`}{metrics.data?.engineCpuCount != null && <small> / {metrics.data.engineCpuCount * 100}%</small>}</strong><p>{metrics.data?.engineCpuCount != null ? t('엔진 CPU {count}개', { count: metrics.data.engineCpuCount }) : t("엔진 CPU 수 확인 중")}</p></div><div><span className="muted">{t("컨테이너 메모리")}</span><strong>{memory === null ? t("미확인") : formatBytes(memory)}{metrics.data?.memoryTotalBytes != null && <small> / {formatBytes(metrics.data.memoryTotalBytes)}</small>}</strong><p>{metrics.error ?? (metrics.loading ? t("백그라운드에서 사용량 측정 중…") : t("전체 새로고침 시 측정 · Linux 파일 캐시 제외"))}</p></div></div>;
}
