type Inspect = Record<string, any>;
const quote = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
export function containerRunCommand(data: Inspect): string {
  const config = data.Config ?? {}, host = data.HostConfig ?? {};
  const args: unknown[] = ['wsl', '--distribution', 'DockSlate', '--user', 'root', '--exec', '/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', 'run', '--name', String(data.Name ?? '').replace(/^\//, '')];
  const option = (name: string, value: unknown) => { if (value !== undefined && value !== null && value !== '') args.push(name, value); };
  option('--restart', host.RestartPolicy?.Name); option('--workdir', config.WorkingDir); option('--user', config.User);
  if (host.Memory > 0) option('--memory', host.Memory);
  if (host.NanoCpus > 0) option('--cpus', host.NanoCpus / 1e9);
  if (host.ReadonlyRootfs) args.push('--read-only');
  if (config.Tty) args.push('-t'); if (config.OpenStdin) args.push('-i');
  option('--network', host.NetworkMode);
  for (const env of config.Env ?? []) option('--env', env);
  for (const [port, bindings] of Object.entries(host.PortBindings ?? {})) for (const binding of (bindings as any[]) ?? []) {
    let address = String(binding.HostIp || '127.0.0.1'); if (address.includes(':')) address = `[${address}]`;
    option('--publish', `${address}:${binding.HostPort}:${port}`);
  }
  for (const mount of data.Mounts ?? []) if (['volume', 'bind'].includes(mount.Type)) option('--mount', `type=${mount.Type},source=${mount.Type === 'volume' ? mount.Name : mount.Source},target=${mount.Destination}${mount.RW === false ? ',readonly' : ''}`);
  for (const [key, value] of Object.entries(config.Labels ?? {})) option('--label', `${key}=${value}`);
  const entrypoint = Array.isArray(config.Entrypoint) ? config.Entrypoint : [];
  option('--entrypoint', entrypoint[0]);
  args.push(data.Image, ...entrypoint.slice(1), ...(config.Cmd ?? []));
  return args.map((arg, index) => index < 12 && /^[\w/:.-]+$/.test(String(arg)) ? String(arg) : quote(arg)).join(' ');
}
