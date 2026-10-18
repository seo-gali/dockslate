import { t, getLocale } from './i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { backend, type Container, type ContainerMetric, useContainerMetrics } from './api';
import { errorMessage, formatBytes, Icon } from './components';
export function ContainerStats({ container, active, embedded = false }: { container: Container; active: boolean; embedded?: boolean }) {
  const metrics = useContainerMetrics();
  const [sample, setSample] = useState<ContainerMetric | undefined>(() => metrics.data?.samples.find(value => value.id === container.id));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const running = ['running','paused','restarting'].includes(container.state);
  const read = useCallback(async () => {
    const token = ++generation.current;
    if (!running) { setSample(undefined); setLoading(false); setError(null); return; }
    setLoading(true); setError(null);
    try { const value = await backend<ContainerMetric>('container_stats', { id: container.id }); if (token === generation.current) setSample(value); }
    catch (failure) { if (token === generation.current) setError(errorMessage(failure)); }
    finally { if (token === generation.current) setLoading(false); }
  }, [container.id, running]);
  useEffect(() => { if (active) void read(); return () => { generation.current++; }; }, [active, read]);
  const missing = t(running ? '측정 결과 없음' : '중지됨');
  return <div className={`container-stats${embedded ? ' embedded-stats' : ' detail-content'}`}><div className="section-heading"><h3>{t("리소스 사용량")}</h3><button className="button small" disabled={loading || !running} onClick={() => void read()}><Icon name="refresh" size={14} />{t("다시 측정")}</button></div>{loading && <p className="muted" role="status">{t("측정 중…")}</p>}{error && <p className="danger" role="alert">{error}</p>}<dl className="detail-meta"><dt>CPU</dt><dd>{sample?.cpuPercent == null ? missing : sample.cpuPercent.toFixed(2)+'%'}</dd><dt>{t("메모리")}</dt><dd>{sample?.memoryUsageBytes == null ? missing : formatBytes(sample.memoryUsageBytes)+' / '+formatBytes(sample.memoryLimitBytes)}</dd><dt>{t("메모리 비율")}</dt><dd>{sample?.memoryPercent == null ? missing : sample.memoryPercent.toFixed(2)+'%'}</dd><dt>{t("측정 시각")}</dt><dd>{sample?.readAt ? new Date(sample.readAt).toLocaleTimeString(getLocale()) : missing}</dd></dl></div>;
}
