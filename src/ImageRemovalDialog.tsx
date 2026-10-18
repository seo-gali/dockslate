import { useEffect, useRef, useState } from 'react';
import { backend, refreshDashboardAfterMutation, type DestructiveResult, type DockerImage } from './api';
import { ConfirmDialog, StatusBadge, errorMessage } from './components';
import { t } from "./i18n";


interface ImagePreview {
  token: string | null; eligible: boolean; blockedReasons: string[]; expiresAt: number | null;
  image: { id: string; tags: string[]; size: number | null };
  containers: { id: string; name: string; state: string }[];
  deleteReferencingContainers: boolean;
}
interface CheckedImage { image: DockerImage; preview: ImagePreview | null; error: string | null }
export interface ImageRemovalResult extends DestructiveResult { remaining: string[] }

function reasonText(reason: string): string {
  if (reason.startsWith('This image is referenced by existing containers.')) return t("참조 컨테이너가 있습니다. 아래 옵션을 선택하면 중지된 참조 컨테이너를 삭제 대상에 포함해 다시 검사합니다.");
  if (reason.startsWith('Image deletion blocked: every referencing container')) return t("실행 중, 일시 정지, 재시작 또는 상태가 확인되지 않은 참조 컨테이너가 있어 삭제할 수 없습니다. 컨테이너 상태를 직접 변경한 뒤 다시 검사하세요.");
  if (reason.startsWith('This image has multiple tags.')) return t("여러 태그가 연결된 이미지입니다. 강제 삭제가 필요한 상태이므로 DockSlate에서 삭제할 수 없습니다.");
  return reason;
}

export default function ImageRemovalDialog({ images, onClose, onComplete, onBusy }: {
  images: DockerImage[]; onClose: () => void; onComplete: (result: ImageRemovalResult) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [cascade, setCascade] = useState(false);
  const [checked, setChecked] = useState<CheckedImage[]>(() => images.map(image => ({ image, preview: null, error: null })));
  const [validating, setValidating] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [progress, setProgress] = useState('');
  const generation = useRef(0);
  const inFlight = useRef(false);
  const callbacks = useRef({ onBusy, onClose, onComplete });
  callbacks.current = { onBusy, onClose, onComplete };
  useEffect(() => { callbacks.current.onBusy?.(true); return () => { generation.current += 1; callbacks.current.onBusy?.(false); }; }, []);
  useEffect(() => {
    const current = ++generation.current;
    let cancelled = false;
    setValidating(true); setAcknowledged(false); setError(null);
    setChecked(images.map(image => ({ image, preview: null, error: null })));
    if (images.length > 100) {
      setError('이미지는 한 번에 최대 100개까지 선택할 수 있습니다.'); setValidating(false);
      return () => { cancelled = true; };
    }
    const inspect = async () => {
      const results: CheckedImage[] = images.map(image => ({ image, preview: null, error: null }));
      let next = 0;
      const worker = async () => {
        while (next < images.length && !cancelled) {
          const index = next++;
          try { results[index].preview = await backend<ImagePreview>('image_removal_preview', { id: images[index].id, deleteReferencingContainers: cascade }); }
          catch (failure) { results[index].error = errorMessage(failure); }
          if (!cancelled && generation.current === current) setChecked(results.map(result => ({ ...result })));
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, images.length) }, worker));
      if (!cancelled && generation.current === current) setValidating(false);
    };
    void inspect();
    return () => { cancelled = true; };
  }, [cascade, revision, images]);
  const ready = images.length > 0 && checked.length === images.length && !validating && checked.every(result => result.preview?.eligible && !!result.preview.token && !result.error);
  const execute = async () => {
    if (!ready || !acknowledged || inFlight.current) return;
    if (checked.some(result => !result.preview?.expiresAt || result.preview.expiresAt <= Date.now())) { setError('승인 정보가 만료되었습니다. 대상을 다시 검사하세요.'); setAcknowledged(false); return; }
    inFlight.current = true; setExecuting(true); setError(null);
    const deleted: string[] = [];
    const failed: { id: string; error: string }[] = [];
    const remaining = new Set(checked.flatMap(result => [result.image.id, ...(result.preview?.containers.map(container => container.id) ?? [])]));
    try {
      for (let index = 0; index < checked.length; index += 1) {
        const result = checked[index];
        if (!result.preview?.token || !result.preview.expiresAt || result.preview.expiresAt <= Date.now()) { failed.push({ id: result.image.id, error: '승인 정보가 만료되어 후속 삭제를 중단했습니다.' }); break; }
        setProgress(`${index + 1} / ${checked.length} 이미지 처리 중…`);
        try {
          const removed = await backend<ImageRemovalResult>('image_removal_execute', { token: result.preview.token, approved: true });
          deleted.push(...removed.deleted);
          removed.deleted.forEach(id => remaining.delete(id));
          failed.push(...removed.failed);
          if (removed.failed.length) break;
        } catch (failure) { failed.push({ id: result.image.id, error: errorMessage(failure) }); break; }
      }
    } finally {
      await refreshDashboardAfterMutation();
      inFlight.current = false; setExecuting(false);
    }
    callbacks.current.onComplete({ message: `이미지 삭제: ${deleted.length}개 삭제, ${failed.length}개 실패${remaining.size ? ` · ${remaining.size}개 미완료` : ''}`, deleted, failed, remaining: [...remaining] });
    callbacks.current.onClose();
  };
  return <ConfirmDialog title={t("이미지 삭제 확인")} label="선택한 대상 삭제" busy={executing} ready={ready} error={error} acknowledged={acknowledged} onAcknowledge={setAcknowledged} onCancel={() => { if (!inFlight.current) callbacks.current.onClose(); }} onConfirm={() => void execute()}>
    <p>{t("선택한 이미지") + " "}{images.length}{t("개와 현재 참조 컨테이너를 검사합니다.")}</p>
    <label className="checkbox-control" style={{ margin: '14px 0' }}><input type="checkbox" checked={cascade} disabled={executing || validating} onChange={event => { setCascade(event.target.checked); setAcknowledged(false); }} />{t("참조 컨테이너도 함께 삭제")}</label>
    <p className="usage-note">{t("이 옵션은 처음에는 선택되지 않습니다. 선택하면 현재 중지된 참조 컨테이너를 삭제 대상에 포함합니다. 실행 중인 컨테이너는 자동으로 중지하지 않습니다.")}</p>
    {validating && <p className="loading-line" role="status">{t("이미지와 컨테이너의 실제 상태를 검사하고 있습니다. (")}{checked.filter(result => result.preview || result.error).length}/{images.length})</p>}
    {executing && <p className="loading-line" role="status">{progress}</p>}
    {checked.map(result => <section key={result.image.id} style={{ margin: '16px 0' }} aria-label={`${result.image.tags[0] ?? result.image.id} 삭제 대상`}><div className="dialog-target">{(result.preview?.image.tags ?? result.image.tags).join(', ') || '<untagged>'}<small className="selectable">{result.image.id}</small></div>{result.preview && <><StatusBadge tone={result.preview.eligible ? 'warning' : 'danger'}>{result.preview.eligible ? t("삭제 가능") : t("삭제 차단")}</StatusBadge>{result.preview.containers.length ? <><p>{cascade ? t("함께 삭제할 참조 컨테이너") : t("이미지를 참조하는 컨테이너")}</p><ul className="dialog-target-list">{result.preview.containers.map(container => <li key={container.id}><strong>{container.name}</strong> · {container.state}<small className="mono selectable">{container.id}</small></li>)}</ul></> : <p className="usage-note">{t("참조하는 컨테이너가 없습니다.")}</p>}{result.preview.blockedReasons.map(reason => <p className="danger" key={reason}>{reasonText(reason)}</p>)}{result.preview.expiresAt && <p className="usage-note">{t("승인 만료:") + " "}{new Date(result.preview.expiresAt).toLocaleTimeString()}</p>}</>}{result.error && <p className="danger" role="alert">{t("대상 검사 실패:") + " "}{result.error}</p>}</section>)}
    <p className="danger">{t("컨테이너를 함께 삭제하면 쓰기 가능한 레이어의 파일과 컨테이너 설정이 영구 삭제됩니다. 이름 있는 볼륨과 익명 볼륨은 모두 유지합니다.")}</p>
    <p>{t("선택한 이미지의 태그, 메타데이터와 참조되지 않는 레이어를 삭제합니다. 다시 다운로드하려면 원본 레지스트리에 접근할 수 있어야 합니다.")}</p>
    <p>{t("삭제는 순서대로 실행합니다. 도중에 실패하면 이미 삭제된 대상은 복구되지 않으며 나머지 삭제를 중단합니다.")}</p>
    {!validating && <button className="button small" disabled={executing} onClick={() => { setAcknowledged(false); setRevision(value => value + 1); }}>{t("대상 다시 검사")}</button>}
  </ConfirmDialog>;
}
