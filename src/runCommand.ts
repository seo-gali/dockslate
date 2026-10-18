import type { RunOptions } from './ImageRunAdvanced';

export interface RunCommandInput {
  imageId: string;
  name: string;
  containerPort: string;
  hostPort: string;
  protocol: string;
  options: RunOptions;
  networkNone: boolean;
}

const powershellQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const csv = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

export function runCommand(input: RunCommandInput, platform: 'powershell' | 'docker' = 'powershell'): string {
  const quote = platform === 'docker' ? (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'" : powershellQuote;
  const { options } = input;
  const settings: string[] = [
    `--detach --pull ${quote('never')} --restart ${quote(options.restartPolicy ?? 'no')}`,
  ];
  if (input.name.trim()) settings.push(`--name ${quote(input.name.trim())}`);
  settings.push(`--network ${quote(input.networkNone ? 'none' : options.networkId || 'bridge')}`);
  if (input.containerPort && !input.networkNone) {
    const port = `127.0.0.1:${input.hostPort ? Number(input.hostPort) : ''}:${Number(input.containerPort)}/${input.protocol}`;
    settings.push(`--publish ${quote(port)}`);
  }
  for (const value of options.env ?? []) settings.push(`--env ${quote(value)}`);
  if (options.workingDir) settings.push(`--workdir ${quote(options.workingDir)}`);
  if (options.memoryBytes != null) settings.push(`--memory ${quote(String(options.memoryBytes))}`);
  if (options.nanoCpus != null) {
    const cpus = (options.nanoCpus / 1_000_000_000).toFixed(9).replace(/\.?0+$/, '');
    settings.push(`--cpus ${quote(cpus)}`);
  }
  for (const mount of options.mounts ?? []) {
    const fields = ['type=volume', `source=${mount.name}`, `target=${mount.target}`, 'volume-nocopy'];
    if (mount.readOnly) fields.push('readonly');
    settings.push(`--mount ${quote(fields.map(csv).join(','))}`);
  }
  const entrypoint = options.entrypoint ?? [];
  if (entrypoint.length) settings.push(`--entrypoint ${quote(entrypoint[0])}`);
  const command = [...entrypoint.slice(1), ...(options.command ?? [])];
  settings.push([input.imageId, ...command].map(quote).join(' '));
  if (platform === 'docker') return "docker --host 'unix:///var/run/docker.sock' run \\\n  " + settings.join(' \\\n  ');
  const continuation = ' `\n    ';
  return [
    '& {',
    "  if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required.' }",
    "  $PSNativeCommandArgumentPassing = 'Standard'",
    "  wsl.exe --distribution 'DockSlate' --user 'root' --exec" + continuation +
      '/usr/bin/env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u DOCKER_API_VERSION' + continuation +
      "/usr/bin/docker --host 'unix:///var/run/docker.sock' run" + continuation +
      settings.join(continuation),
    '}',
  ].join('\n');
}
