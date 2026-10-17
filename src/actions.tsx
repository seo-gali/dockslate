import { useRef, useState } from 'react';
import { backend, refreshDashboardAfterMutation, type DestructivePreview, type DestructiveRequest, type DestructiveResult } from './api';
import { ConfirmDialog, Icon, errorMessage, formatBytes } from './components';

export type Operation = { tone: 'accent' | 'success' | 'warning' | 'danger'; message: string } | null;

export function OperationNotice({ operation, onDismiss }: { operation: Operation; onDismiss?: () => void }) {
  if (!operation) return null;
  return <div className={`operation-banner ${operation.tone}`} role={operation.tone === 'danger' ? 'alert' : 'status'}><Icon name={operation.tone === 'danger' || operation.tone === 'warning' ? 'warning' : operation.tone === 'success' ? 'check' : 'refresh'} /><span>{operation.message}</span>{onDismiss && operation.tone !== 'accent' && <button className="icon-button" onClick={onDismiss} title="알림 닫기" aria-label="알림 닫기"><Icon name="close" size={16} /></button>}</div>;
}

export function useDestructiveAction(onComplete: (result: DestructiveResult) => void | Promise<void>) {
  const [request, setRequest] = useState<DestructiveRequest | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [preview, setPreview] = useState<DestructivePreview | null>(null);
  const [validating, setValidating] = useState(false);
  const [executing, setExecuting] = useState(false);
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
      if (generation.current === current && open.current) setError(`대상 검사 실패: ${errorMessage(failure)}`);
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
    if (preview.expiresAt <= Date.now()) { setError('승인 정보가 만료되었습니다. 대상을 다시 검사하세요.'); setPreview(null); setAcknowledged(false); return; }
    execution.current = true;
    setExecuting(true);
    setError(null);
    try {
      const result = await backend<DestructiveResult>('destructive_execute', { token: preview.token, approved: true });
      open.current = false;
      setRequest(null); setPreview(null);
      setAcknowledged(false);
      const failures = result.failed.map(item => `${item.id}: ${item.error}`).join(' / ');
      const action = result.deleted.length || result.failed.length ? `${preview.kind === 'cleanup' ? '선택한 데이터 정리' : preview.kind === 'image_delete' ? '이미지 삭제' : '컨테이너 삭제'}: ${result.deleted.length}개 완료, ${result.failed.length}개 실패` : result.message;
      setOperation({ tone: result.failed.length ? 'danger' : 'success', message: `${action}${failures ? ` · ${failures}` : ''}` });
      await onComplete(result);
    } catch (failure) {
      setError(errorMessage(failure));
      setPreview(null); setAcknowledged(false);
    } finally {
      await refreshDashboardAfterMutation();
      execution.current = false;
      setExecuting(false);
    }
  };

  const title = request?.kind === 'container_delete' ? '컨테이너 삭제 확인' : request?.kind === 'image_delete' ? '이미지 삭제 확인' : '선택한 데이터 정리 확인';
  const displayTargets = preview?.targets.map(target => targets.find(label => label.endsWith(` · ${target}`)) ?? target) ?? targets;
  const dialog = request && <ConfirmDialog title={title} label={request.kind === 'cleanup' ? '선택한 데이터 정리' : '삭제 실행'} busy={executing} ready={!!preview && !validating} error={error} acknowledged={acknowledged} onAcknowledge={setAcknowledged} onCancel={cancel} onConfirm={() => void execute()}><p>다음 대상에만 작업을 적용합니다.</p><ul className="dialog-target-list">{displayTargets.map((target, index) => <li key={`${target}-${index}`}>{target}</li>)}</ul>{validating && <p className="loading-line" role="status">대상과 현재 참조 상태를 검사하고 있습니다. 검사 후에 승인할 수 있습니다.</p>}{preview && <>{preview.impact.map((impact, index) => <p key={index}>{impactText(impact)}</p>)}{preview.estimatedBytes !== null && <p>Docker 정리 가능 추정치: <strong>{formatBytes(preview.estimatedBytes)}</strong></p>}<p>승인 정보 만료: {new Date(preview.expiresAt).toLocaleTimeString()}</p></>}<p className="danger">이 작업은 DockSlate에서 되돌릴 수 없습니다. 필요한 데이터는 실행 전에 별도로 보관하세요.</p>{!validating && !preview && <button className="button small" disabled={executing} onClick={() => void validate(request)}>대상 다시 검사</button>}</ConfirmDialog>;
  return { busy: executing || request !== null, prepare, dialog, operation, setOperation };
}

function impactText(value: string): string {
  if (value === 'Deletion is irreversible within DockSlate.') return '삭제한 데이터는 DockSlate에서 되돌릴 수 없습니다.';
  if (value === 'Existing volumes are retained. Force deletion and system-wide prune are excluded.') return '기존 볼륨은 유지됩니다. 강제 삭제와 엔진 전체 정리는 실행하지 않습니다.';
  if (value.startsWith('Only selected images are requested for deletion;')) return '선택한 이미지의 메타데이터와 참조되지 않는 레이어를 삭제합니다. 다시 다운로드하려면 원본 레지스트리에 접근할 수 있어야 합니다.';
  if (value.startsWith('The stopped container writable layer and configuration')) return '선택한 중지된 컨테이너의 쓰기 가능한 레이어와 설정을 삭제합니다. 이미지와 이름 있는 볼륨·익명 볼륨은 유지됩니다.';
  if (value.startsWith('Only exact selected unused, unshared build cache IDs')) return '선택한 미사용·비공유 빌드 캐시 ID만 정리합니다. 다음 이미지 빌드에는 시간이 더 걸릴 수 있습니다.';
  return value;
}
