import { useEffect, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { type EngineStatus, useBackendQuery } from './api';
import { ErrorNotice, Icon, RefreshButton, StatePanel, StatusBadge, errorMessage, type IconName } from './components';
import Overview from './pages/Overview';
import Containers from './pages/Containers';
import Images from './pages/Images';
import Volumes from './pages/Volumes';
import Builds from './pages/Builds';
import { useImageBuild } from './ImageBuild';
import DiskManager from './pages/DiskManager';
import Settings from './pages/Settings';
import { useDockSlateRuntime } from './runtime';
import type { RunResult } from './ImageRun';
export interface ContainerOpenRequest extends RunResult { sequence: number }

export type Page = 'Overview' | 'Containers' | 'Images' | 'Volumes' | 'Builds' | 'Disk Manager' | 'Settings';
export interface EngineProps {
  engine: EngineStatus | null;
  engineLoading: boolean;
  engineError: string | null;
  reloadEngine: () => Promise<void>;
  openRuntimeSettings?: () => void;
  active?: boolean;
  mutationBlocked?: boolean;
}

const menu: { page: Page; icon: IconName }[] = [
  { page: 'Overview', icon: 'overview' },
  { page: 'Containers', icon: 'containers' },
  { page: 'Images', icon: 'images' },
  { page: 'Volumes', icon: 'disk' },
  { page: 'Builds', icon: 'images' },
  { page: 'Disk Manager', icon: 'disk' },
  { page: 'Settings', icon: 'settings' },
];

export function engineLabel(engine: EngineStatus | null, loading = false): string {
  if (loading && !engine) return '연결 확인 중';
  if (!engine) return '백엔드 연결 실패';
  return { connected: 'Connected', busy: '작업 중', unavailable: 'Disconnected', unsupported: '지원하지 않는 엔진', permission_denied: '권한 부족' }[engine.state];
}

export function EngineGate({ engine, engineLoading, engineError, reloadEngine, openRuntimeSettings, children }: EngineProps & { children: ReactNode }) {
  if (engineLoading && !engine) return <StatePanel busy title="Docker Engine 연결 확인 중" description="DockSlate 전용 엔진의 설치와 실행 상태를 확인하고 있습니다." />;
  if (engine?.state === 'connected') return <>{children}</>;
  if (engine?.state === 'busy') return <StatePanel busy title="런타임·디스크 작업 중" description="작업을 마치면 연결 상태와 목록을 자동으로 다시 조회합니다." />;
  return <>{engineError && <ErrorNotice message={engineError} />}<StatePanel icon={engine?.state === 'permission_denied' ? 'warning' : 'containers'} title={engine?.state === 'permission_denied' ? 'Docker Engine 접근 권한이 없습니다' : engine?.state === 'unsupported' ? '독립 엔진을 사용할 수 없습니다' : 'DockSlate 엔진이 실행되지 않았습니다'} description={engine?.message ?? engineError ?? 'Settings에서 독립 엔진의 설치와 실행 상태를 확인하세요.'}><RefreshButton busy={engineLoading} onClick={() => void reloadEngine()} />{openRuntimeSettings && <button className="button primary" onClick={openRuntimeSettings}>엔진 설정</button>}</StatePanel></>;
}

export default function App() {
  const [page, setPage] = useState<Page>('Overview');
  const [diskBusy, setDiskBusy] = useState(false);
  const [imageBuildBusy, setImageBuildBusy] = useState(false);
  const [imageRunBusy, setImageRunBusy] = useState(false);
  const [volumeBusy, setVolumeBusy] = useState(false);
  const [buildTransferBusy, setBuildTransferBusy] = useState(false);
  const build = useImageBuild(setImageBuildBusy);
  const [containerRequest, setContainerRequest] = useState<ContainerOpenRequest | null>(null);
  const [dockerTabRequest, setDockerTabRequest] = useState(0);
  const [closeNotice, setCloseNotice] = useState<string | null>(null);
  const engineQuery = useBackendQuery<EngineStatus>('engine_status');
  const runtime = useDockSlateRuntime(imageBuildBusy || imageRunBusy || volumeBusy || buildTransferBusy);
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void listen<string>('close-blocked', event => setCloseNotice(event.payload)).then(stop => {
      if (disposed) stop(); else unsubscribe = stop;
    }).catch(failure => setCloseNotice(`앱 상태 알림을 수신하지 못했습니다: ${errorMessage(failure)}`));
    return () => { disposed = true; unsubscribe?.(); };
  }, []);
  useEffect(() => {
    if (engineQuery.loading || engineQuery.data?.state !== 'busy') return;
    const timer = window.setTimeout(() => void engineQuery.poll(), 1000);
    return () => window.clearTimeout(timer);
  }, [engineQuery.loading, engineQuery.poll, engineQuery.data?.state]);
  const engine: EngineStatus | null = runtime.busy || diskBusy ? {
    ...engineQuery.data, state: 'busy', context: 'dockslate', endpoint: 'wsl://DockSlate/var/run/docker.sock',
    engine: engineQuery.data?.engine ?? null, serverVersion: engineQuery.data?.serverVersion ?? null,
    apiVersion: engineQuery.data?.apiVersion ?? null, ownerPath: engineQuery.data?.ownerPath ?? null,
    message: diskBusy ? '디스크 작업이 끝날 때까지 엔진 연결을 기다립니다.' : '런타임 작업이 끝나면 연결 상태를 자동으로 확인합니다.',
  } : engineQuery.data;
  const engineProps: EngineProps = { engine, engineLoading: engineQuery.loading, engineError: engine?.state === 'busy' ? null : engineQuery.error, reloadEngine: engineQuery.reload, openRuntimeSettings: () => setPage('Settings'), mutationBlocked: imageBuildBusy || imageRunBusy || volumeBusy || buildTransferBusy };
  const busy = diskBusy;
  const tone = engine?.state === 'connected' ? 'success' : engine?.state === 'busy' ? 'accent' : engine?.state === 'permission_denied' ? 'danger' : 'warning';

  return <div className="app-shell"><header className="app-topbar"><div className="app-brand"><span className="brand-mark"><svg viewBox="0 0 28 28" width="25" height="25" fill="none" aria-hidden="true"><path d="M5 5h11l7 7v11H12l-7-7z" stroke="currentColor" strokeWidth="2" /><path d="M5 16h11V5M16 16l7 7" stroke="currentColor" strokeWidth="2" /></svg></span>DockSlate</div><div className="engine-topline"><span className="topline-owner">DockSlate{engine?.engine ? ` · ${engine.engine}` : ''}</span><StatusBadge tone={tone}>{engineLabel(engine, engineQuery.loading)}</StatusBadge></div></header><aside className="sidebar"><p className="nav-label">Workspace</p><nav aria-label="주요 메뉴">{menu.map(item => <div key={item.page}>{item.page === 'Settings' && <div className="nav-divider" />}<button className={`nav-item ${page === item.page ? 'active' : ''}`} disabled={busy} title={busy ? "작업이 진행 중입니다" : undefined} onClick={() => setPage(item.page)} aria-current={page === item.page ? 'page' : undefined}><Icon name={item.icon} />{item.page}</button></div>)}</nav></aside><main className="main-content"><div className="page">{imageBuildBusy && <div className="notice info" role="status"><Icon name="images" /><div><strong>이미지 빌드 중</strong><p>다른 메뉴를 확인하는 동안 빌드를 계속합니다.</p></div><button className="button small" onClick={() => setPage('Builds')}>빌드 보기</button></div>}{closeNotice && <div className="notice warning-notice" role="alert"><Icon name="warning" /><div><strong>앱 종료 상태</strong><p>{closeNotice}</p></div><button className="icon-button" onClick={() => setCloseNotice(null)} aria-label="종료 알림 닫기" title="종료 알림 닫기"><Icon name="close" size={16} /></button></div>}<div data-page="Overview" hidden={page !== 'Overview'}><Overview {...engineProps} navigate={next => { if (next === 'Disk Manager') setDockerTabRequest(value => value + 1); setPage(next); }} /></div><div data-page="Containers" hidden={page !== 'Containers'}><Containers {...engineProps} active={page === 'Containers'} openRequest={containerRequest} /></div><div data-page="Images" hidden={page !== 'Images'}><Images {...engineProps} build={build} openBuilds={() => setPage('Builds')} onRunBusy={setImageRunBusy} onContainerCreated={result => { setContainerRequest({ ...result, sequence: Date.now() }); setPage('Containers'); }} /></div><div data-page="Volumes" hidden={page !== 'Volumes'}><Volumes {...engineProps} onBusy={setVolumeBusy} /></div><div data-page="Builds" hidden={page !== 'Builds'}><Builds {...engineProps} build={build} onBusy={setBuildTransferBusy} /></div><div data-page="Disk Manager" hidden={page !== 'Disk Manager'}><DiskManager {...engineProps} runtime={runtime} dockerTabRequest={dockerTabRequest} onDiskBusy={setDiskBusy} /></div><div data-page="Settings" hidden={page !== 'Settings'}><Settings {...engineProps} runtime={runtime} /></div></div></main>{runtime.dialog}</div>;
}
