import { backend } from './client';
import type { Container } from './contracts/core';

// Compile these contracts without sending IPC or loading a native backend.
export function checkCommandTypes() {
  const containers: Promise<Container[]> = backend('containers_list');
  void containers;
  void backend('container_action', { id: 'example', action: 'start' });
  // @ts-expect-error Unknown command names must fail before runtime.
  void backend('containers_lsit');
  // @ts-expect-error An approved mutation still requires its token.
  void backend('container_edit_execute', { approved: true });
  // @ts-expect-error IDs use strings across the IPC boundary.
  void backend('container_stats', { id: 12 });
  // @ts-expect-error Required arguments cannot be omitted.
  void backend('image_search');
  // @ts-expect-error The command chooses its return type, not the caller.
  const invalid: Promise<string> = backend('containers_list');
  void invalid;
  void backend('dashboard_snapshot').then(snapshot => {
    // @ts-expect-error A snapshot field retains the corresponding command's result type.
    const wrong: string = snapshot.containers_list.Ok;
    void wrong;
  });
}
