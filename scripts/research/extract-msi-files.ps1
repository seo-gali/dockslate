param(
  [Parameter(Mandatory = $true)][string]$InventoryDirectory,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$InventoryDirectory = (Resolve-Path -LiteralPath $InventoryDirectory).Path
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output directory must be new' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$inventory = Get-Content -LiteralPath (Join-Path $InventoryDirectory 'msi-inventory.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$directories = @{}
$components = @{}
foreach ($item in $inventory.directories) { $directories[$item.id] = $item }
foreach ($item in $inventory.components) { $components[$item.id] = $item.directory }

function Get-RelativeDirectory([string]$Id) {
  if ($Id -eq 'APPLICATIONFOLDER') { return '' }
  if (-not $directories.ContainsKey($Id)) { throw 'Unresolved directory' }
  $directory = $directories[$Id]
  $name = $directory.name.Split(':')[0].Split('|')[-1]
  $parent = Get-RelativeDirectory $directory.parent
  if ($name -eq '.') { return $parent }
  if (-not $parent) { return $name }
  return Join-Path $parent $name
}

$records = @()
$staging = Join-Path $OutputDirectory '_cab-members'
New-Item -ItemType Directory -Path $staging | Out-Null
foreach ($file in $inventory.files) {
  $name = $file.name.Split('|')[-1]
  $directory = Get-RelativeDirectory $components[$file.component]
  $relative = if ($directory) { Join-Path $directory $name } else { $name }
  if ($relative -notmatch '(?i)(^LICENSE|^resources\\(app\.asar($|\.unpacked\\)|resources\\preload\.js$))') { continue }
  $media = $inventory.media | Where-Object { $_.last_sequence -ge $file.sequence } | Sort-Object disk | Select-Object -First 1
  $cabinet = Join-Path $InventoryDirectory ('media-' + $media.disk + '.cab')
  $destination = [IO.Path]::GetFullPath((Join-Path $OutputDirectory $relative))
  if (-not $destination.StartsWith($OutputDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Destination escapes output directory' }
  & "$env:SystemRoot\System32\expand.exe" $cabinet ('-F:' + $file.id) $staging | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'CAB expansion failed' }
  $source = Join-Path $staging $file.id
  if ((Get-Item -LiteralPath $source).Length -ne $file.size) { throw 'File size mismatch' }
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
  Move-Item -LiteralPath $source -Destination $destination
  $records += [pscustomobject]@{
    relative_path = $relative; file_id = $file.id; cabinet = $media.cabinet; sequence = $file.sequence
    size = $file.size; sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
$records | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'extraction-manifest.json') -Encoding UTF8
$records | Where-Object { $_.relative_path -match '(app\.asar$|preload\.js$|LICENSE)' } | ConvertTo-Json
Write-Output ('Extracted files: ' + $records.Count)
