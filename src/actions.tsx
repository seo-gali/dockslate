import { useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { backend, refreshDashboardAfterMutation, type DestructivePreview, type DestructiveRequest, type DestructiveResult } from './api';
import { ConfirmDialog, Icon, TaskProgress, errorMessage, formatBytes } from './components';
import { getLocale, t } from "./i18n";


export type Operation = { tone: 'accent' | 'success' | 'warning' | 'danger'; message: string; failures?: { id: string; label: string; error: string }[] } | null;
interface DeletionProgress { requestId: string; phase: 'validating' | 'deleting'; completed: number; total: number; target?: string }

export function OperationNotice({ operation, onDismiss, onRefresh, refreshing }: { operation: Operation; onDismiss?: () => void; onRefresh?: () => void; refreshing?: boolean }) {
  if (!operation) return null;
  return <div className={`operation-banner ${operation.tone}`} role={operation.tone === 'danger' ? 'alert' : 'status'}><Icon name={operation.tone === 'danger' || operation.tone === 'warning' ? 'warning' : operation.tone === 'success' ? 'check' : 'refresh'} />{operation.tone === 'accent' ? <TaskProgress label={operation.message} /> : <div className="operation-message"><p>{operation.message}</p>{!!operation.failures?.length && <><p>{t('완료된 항목은 처리되었습니다. 실패 항목의 사유를 확인하고 목록을 새로고친 뒤 다시 선택하세요.')}</p><details className="operation-failures"><summary>{t('실패 항목 {count}개 보기', { count: operation.failures.length })}</summary><ul>{operation.failures.map(item => <li key={item.id}><strong>{item.label}</strong><p>{failureText(item.error)}</p><code>{item.id}</code></li>)}</ul></details></>}</div>}{!!operation.failures?.length && onRefresh && <button className="button small" disabled={refreshing} onClick={onRefresh}>{refreshing ? t('조회 중…') : t('목록 새로고침')}</button>}{onDismiss && operation.tone !== 'accent' && <button className="icon-button" onClick={onDismiss} data-tooltip={t("알림 닫기")} aria-label={t("알림 닫기")}><Icon name="close" size={16} /></button>}</div>;
}

function failureText(error: string): string {
  if (error.startsWith('Cleanup blocked: ')) return t(error.slice('Cleanup blocked: '.length));
  return t(error);
}

export function useDestructiveAction(onComplete: (result: DestructiveResult) => void | Promise<void>) {
  const [request, setRequest] = useState<DestructiveRequest | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [preview, setPreview] = useState<DestructivePreview | null>(null);
  const [validating, setValidating] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<DeletionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [operation, setOperation] = useState<Operation>(null);
  const generation = useRef(0);
  const open = useRef(false);
  const execution = useRef(false);

  const validate = async (value: DestructiveRequest) => {
    const current = ++generation.current;
    setValidating(true);
    setPreview(null);
    setAcknowledged(false);
    setError(null);
    try {
      const checked = await backend<DestructivePreview>('destructive_preview', { request: value });
      if (generation.current === current && open.current) setPreview(checked);
    } catch (failure) {
      if (generation.current === current && open.current) setError(t("대상 검사 실패: {p1}", { p1: errorMessage(failure) }));
    } finally { if (generation.current === current) setValidating(false); }
  };
  const prepare = async (value: DestructiveRequest, labels?: string[]) => {
    if (open.current || execution.current) return;
    open.current = true;
    setRequest(value);
    setTargets(labels ?? [...(value.ids ?? []), ...(value.imageIds ?? []), ...(value.buildCacheIds ?? [])]);
    setOperation(null);
    await validate(value);
  };
  const cancel = () => {
    if (execution.current) return;
    open.current = false;
    generation.current += 1;
    setRequest(null); setPreview(null); setAcknowledged(false); setError(null); setValidating(false);
  };

  const execute = async () => {
    if (!preview || !acknowledged || validating || execution.current) return;
    if (preview.expiresAt <= Date.now()) { setError(t("승인 정보가 만료되었습니다. 대상을 다시 검사하세요.")); setPreview(null); setAcknowledged(false); return; }
    execution.current = true;
    setExecuting(true);
    setProgress(null);
    setError(null);
    let unlisten: (() => void) | undefined;
    try {
      const requestId = crypto.randomUUID();
      unlisten = await listen<DeletionProgress>('destructive-progress', event => {
        if (event.payload.requestId === requestId) setProgress(event.payload);
      });
      const result = await backend<DestructiveResult>('destructive_execute', { token: preview.token, approved: true, requestId });
      open.current = false;
      setRequest(null); setPreview(null);
      setAcknowledged(false);
      const failures = result.failed.map(item => ({ ...item, label: targets.find(label => label.endsWith(` · ${item.id}`))?.slice(0, -(` · ${item.id}`).length) ?? item.id }));
      const action = result.deleted.length || result.failed.length ? t("{p1}: {p2}개 완료, {p3}개 실패", { p1: preview.kind === 'cleanup' ? t("선택한 데이터 정리") : preview.kind === 'image_delete' ? t("이미지 삭제") : t("컨테이너 삭제"), p2: result.deleted.length, p3: result.failed.length }) : result.message;
      setOperation({ tone: failures.length ? result.deleted.length ? 'warning' : 'danger' : 'success', message: action, failures });
      await onComplete(result);
    } catch (failure) {
      setError(errorMessage(failure));
      setPreview(null); setAcknowledged(false);
    } finally {
      unlisten?.();
      await refreshDashboardAfterMutation();
      execution.current = false;
      setExecuting(false);
    }
  };

  const title = request?.kind === 'container_delete' ? t("컨테이너 삭제 확인") : request?.kind === 'image_delete' ? t("이미지 삭제 확인") : t("선택한 데이터 정리 확인");
  const displayTargets = preview?.targets.map(target => targets.find(label => label.endsWith(` · ${target}`)) ?? target) ?? targets;
  const dialog = request && <ConfirmDialog title={title} label={request.kind === 'cleanup' ? t("선택한 데이터 정리") : t("삭제 실행")} busy={executing} progress={{ label: t(progress?.phase === 'deleting' ? '선택한 대상 삭제 중…' : '대상 상태 재확인 중…'), completed: progress?.completed, total: progress?.total, detail: progress?.target }} ready={!!preview && !validating} error={error} acknowledged={acknowledged} onAcknowledge={setAcknowledged} onCancel={cancel} onConfirm={() => void execute()}><ul className="dialog-target-list">{displayTargets.map((target, index) => <li key={`${target}-${index}`}>{target}</li>)}</ul>{validating && <p className="loading-line" role="status">{t("대상과 현재 참조 상태를 검사하고 있습니다. 검사 후에 승인할 수 있습니다.")}</p>}{preview && <>{preview.impact.map(impactText).filter(Boolean).map((impact, index) => <p key={index}>{impact}</p>)}{preview.estimatedBytes !== null && <p>{t("Docker 정리 가능 추정치:") + " "}<strong>{formatBytes(preview.estimatedBytes)}</strong></p>}<p>{t("승인 정보 만료:") + " "}{new Date(preview.expiresAt).toLocaleTimeString(getLocale())}</p></>}<p className="danger">{t("선택한 대상만 삭제하며 볼륨은 유지합니다. 삭제한 데이터는 복구할 수 없습니다.")}</p>{!validating && !preview && <button className="button small" disabled={executing} onClick={() => void validate(request)}>{t("대상 다시 검사")}</button>}</ConfirmDialog>;
  return { busy: executing || request !== null, prepare, dialog, operation, setOperation };
}

function impactText(value: string): string | null {
  if (value === 'Deletion is irreversible within DockSlate.' || value === 'Existing volumes are retained. Force deletion and system-wide prune are excluded.') return null;
  if (value.startsWith('Only selected images are requested for deletion;')) return t("이미지와 미참조 레이어를 삭제합니다. 다시 받으려면 원본 레지스트리에 접근할 수 있어야 합니다.");
  if (value.startsWith('The stopped container writable layer and configuration')) return t("선택한 중지된 컨테이너의 쓰기 가능한 레이어와 설정을 삭제합니다. 이미지와 이름 있는 볼륨·익명 볼륨은 유지됩니다.");
  if (value.startsWith('Only exact selected unused, unshared build cache IDs')) return t("선택한 빌드 캐시를 삭제합니다. 다음 빌드가 더 오래 걸릴 수 있습니다.");
  return value;
}
