import { backend } from './client';
import type { Container } from './contracts/core';

export function checkCommandTypes() {
  const containers: Promise<Container[]> = backend('containers_list');
  void containers;
  void backend('container_action', { id: 'example', action: 'start' });
  // @ts-expect-error
  void backend('containers_lsit');
  // @ts-expect-error
  void backend('container_edit_execute', { approved: true });
  // @ts-expect-error
  void backend('container_stats', { id: 12 });
  // @ts-expect-error
  void backend('image_search');
  // @ts-expect-error
  const invalid: Promise<string> = backend('containers_list');
  void invalid;
  void backend('dashboard_snapshot').then(snapshot => {
    // @ts-expect-error
    const wrong: string = snapshot.containers_list.Ok;
    void wrong;
  });
}
