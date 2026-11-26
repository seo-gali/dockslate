import type { Inventory, Item, Selection } from './ipc/contracts/migration';

export const migrationKinds = ['containers', 'volumes', 'images'] as const;
export type MigrationItems = Pick<Inventory, typeof migrationKinds[number]>;
export type MigrationGroup = MigrationItems & { id: string; name: string; kind: 'project' | 'standalone' | 'resources' };

export function groupMigrationInventory(inventory: Inventory): MigrationGroup[] {
  const groups = new Map<string, MigrationGroup>();
  const images = new Map<string, Item[]>();
  const volumes = new Map(inventory.volumes.map(item => [item.id, item]));
  const assignedImages = new Set<string>(), assignedVolumes = new Set<string>();
  for (const item of inventory.images) images.set(item.id, [...images.get(item.id) ?? [], item]);
  const group = (id: string, name: string, kind: MigrationGroup['kind']) => {
    let value = groups.get(id);
    if (!value) { value = { id, name, kind, containers: [], images: [], volumes: [] }; groups.set(id, value); }
    return value;
  };
  for (const container of inventory.containers) {
    const current = container.project ? group('project:' + container.project, container.project, 'project') : group('standalone', '', 'standalone');
    current.containers.push(container);
    for (const image of images.get(container.image ?? '') ?? []) { current.images.push(image); assignedImages.add(image.id); }
    for (const name of container.volumes ?? []) { const volume = volumes.get(name); if (volume) { current.volumes.push(volume); assignedVolumes.add(name); } }
  }
  for (const volume of inventory.volumes) if (volume.project) {
    group('project:' + volume.project, volume.project, 'project').volumes.push(volume); assignedVolumes.add(volume.id);
  }
  const remainingImages = inventory.images.filter(item => !assignedImages.has(item.id));
  const remainingVolumes = inventory.volumes.filter(item => !assignedVolumes.has(item.id));
  if (remainingImages.length || remainingVolumes.length) Object.assign(group('resources', '', 'resources'), { images: remainingImages, volumes: remainingVolumes });
  return [...groups.values()].map(value => ({ ...value, ...Object.fromEntries(migrationKinds.map(kind => [kind, [...new Map(value[kind].map(item => [item.id + '\0' + item.name, item])).values()]])) }))
    .sort((a, b) => (a.kind === 'project' ? 0 : a.kind === 'standalone' ? 1 : 2) - (b.kind === 'project' ? 0 : b.kind === 'standalone' ? 1 : 2) || a.name.localeCompare(b.name));
}

export function selectMigrationItems(selection: Selection, items: MigrationItems, selected: boolean): Selection {
  return { ...selection, ...Object.fromEntries(migrationKinds.map(kind => {
    const current = new Set(selection[kind]);
    for (const item of items[kind]) { if (selected) current.add(item.id); else current.delete(item.id); }
    return [kind, [...current]];
  })) };
}
