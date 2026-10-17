import { useEffect, useRef, useState } from 'react';
import { backend, type Container, type ContainerMetric, useContainerMetrics } from './api';
import { errorMessage, formatBytes } from './components';

export function ContainerStats({ container, active }: { container: Container; active: boolean }) {
  const metrics = useContainerMetrics();
  const initial = metrics.data?.samples.find(sample => sample.id === container.id);
  const [sample, setSample] = useState<ContainerMetric | undefined>(initial);
  const [live, setLive] = useState(false);
  const [history, setHistory] = useState<ContainerMetric[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  useEffect(() => { if (initial) { setSample(initial); setHistory(previous => [...previous, initial].slice(-30)); } }, [initial]);
  useEffect(() => {
    if (!live || !active || !['running', 'paused'].includes(container.state)) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      if (pending.current) return;
      pending.current = true;
      void backend<ContainerMetric>('container_stats', { id: container.id }).then(value => {
        if (!disposed) { setSample(value); setHistory(previous => [...previous, value].slice(-30)); setError(null); }
      }).catch(failure => { if (!disposed) setError(errorMessage(failure)); }).finally(() => { pending.current = false; });
    }, 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [active, live, container.id, container.state]);
  const measured = history.filter(value => value.cpuPercent != null);
  const scale = Math.max(100, ...measured.map(value => value.cpuPercent!));
  const cpu = measured.map((value, index) => `${index * 300 / Math.max(1, measured.length - 1)},${100 - value.cpuPercent! / scale * 100}`).join(' ');
  return <div className="detail-content"><label className="checkbox-control"><input type="checkbox" checked={live} onChange={event => setLive(event.target.checked)} />실시간 측정 · 이 화면을 볼 때만 2초 간격</label>{error && <p className="danger">{error}</p>}<dl className="detail-meta" style={{ marginTop: 18 }}><dt>CPU</dt><dd>{sample?.cpuPercent == null ? sample?.cpuReason ?? '측정 결과 없음' : `${sample.cpuPercent.toFixed(2)}%`}</dd><dt>메모리</dt><dd>{sample?.memoryUsageBytes == null ? sample?.memoryReason ?? '측정 결과 없음' : `${formatBytes(sample.memoryUsageBytes)} / ${formatBytes(sample.memoryLimitBytes)}`}</dd><dt>메모리 비율</dt><dd>{sample?.memoryPercent == null ? '미확인' : `${sample.memoryPercent.toFixed(2)}%`}</dd><dt>측정 시각</dt><dd>{sample?.readAt ? new Date(sample.readAt).toLocaleTimeString() : '미확인'}</dd></dl>{measured.length > 1 && <svg viewBox="0 0 300 110" role="img" aria-label="최근 CPU 사용량" style={{ width: '100%', marginTop: 18 }}><path d="M0 100H300M0 50H300M0 0H300" stroke="var(--border)" /><polyline points={cpu} fill="none" stroke="var(--accent)" strokeWidth="2" /></svg>}<p className="usage-note">CPU 100%는 코어 1개에 해당합니다. 메모리는 Linux 파일 캐시를 제외한 값입니다.</p></div>;
}
