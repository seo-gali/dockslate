export function createContainerActionQueue(changed: (pending: Map<string, 'queued' | 'running'>) => void) {
  const pending = new Map<string, 'queued' | 'running'>();
  let tail = Promise.resolve();
  return {
    enqueue(ids: string[], action: () => Promise<void>): Promise<void> {
      if (ids.some(id => pending.has(id))) return Promise.resolve();
      for (const id of ids) pending.set(id, 'queued');
      changed(new Map(pending));
      const result = tail.then(async () => {
        for (const id of ids) pending.set(id, 'running');
        changed(new Map(pending));
        try { await action(); }
        finally {
          for (const id of ids) pending.delete(id);
          changed(new Map(pending));
        }
      });
      tail = result.catch(() => {});
      return result;
    },
  };
}
