export const engineOnLaunchKey = 'dockslate.startEngineOnLaunch';

export function readEngineOnLaunch(storage: Pick<Storage, 'getItem'>): boolean {
  try { return storage.getItem(engineOnLaunchKey) !== 'false'; }
  catch { return false; }
}
