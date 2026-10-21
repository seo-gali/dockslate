[CmdletBinding()]
param([switch]$AllowDownload)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $PSScriptRoot 'windows-docker.manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.platform -cne 'windows-amd64') { throw 'Unsupported Windows Docker component manifest.' }
$cacheRoot = Join-Path $projectRoot 'src-tauri\target\windows-docker-cache'
$stageRoot = Join-Path $projectRoot 'src-tauri\target\windows-docker'
$releaseRoot = Join-Path $projectRoot 'src-tauri\target\release\libexec'

function Assert-PlainPath([string]$path) {
    $cursor = [IO.Path]::GetFullPath($path)
    if (!$cursor.StartsWith(($projectRoot + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Windows Docker preparation must remain inside the workspace.' }
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Component preparation paths must not contain links or reparse points.' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if (!$parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Get-CheckedAsset($asset) {
    if ([IO.Path]::GetFileName($asset.cacheFile) -cne $asset.cacheFile -or !([uri]$asset.url).IsAbsoluteUri -or ([uri]$asset.url).Scheme -cne 'https') { throw 'Invalid fixed component source or cache filename.' }
    $cached = Join-Path $cacheRoot $asset.cacheFile
    Assert-PlainPath $cached
    if (!(Test-Path -LiteralPath $cached -PathType Leaf)) {
        if (!$AllowDownload) { throw "Missing offline component cache: $($asset.cacheFile). No download was attempted. After approval, run scripts/prepare-windows-docker.ps1 -AllowDownload." }
        New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
        $partial = Join-Path $cacheRoot ($asset.cacheFile + '.' + [guid]::NewGuid().ToString('N') + '.partial')
        Assert-PlainPath $partial
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $asset.url -OutFile $partial -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 900
            $null = Assert-AssetHash $asset $partial
            Move-Item -LiteralPath $partial -Destination $cached
        } finally {
            if (Test-Path -LiteralPath $partial -PathType Leaf) { Remove-Item -LiteralPath $partial -Force }
        }
    }
    $sha256 = Assert-AssetHash $asset $cached
    if (!$asset.sha256) {
        Write-Host ([ordered]@{ id = $asset.id; path = $cached; bytes = (Get-Item -LiteralPath $cached).Length; observedSha256 = $sha256; publisherSha256Verified = $false; manifestPinRequired = $true; staged = $false } | ConvertTo-Json)
        throw "The Docker ZIP only has a bootstrap size/ETag MD5 pin. Observed SHA-256: $sha256. Review and pin assets[0].sha256 in scripts/windows-docker.manifest.json, then rerun offline. No component was staged."
    }
    return $cached
}

function Assert-AssetHash($asset, [string]$path) {
    if ((Get-Item -LiteralPath $path).Length -ne $asset.bytes) { throw "Component size mismatch: $($asset.id). Existing cache is preserved." }
    $sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($asset.sha256) {
        if ($sha256 -cne $asset.sha256) { throw "Component SHA-256 mismatch: $($asset.id). Existing cache is preserved." }
    } elseif ($asset.id -ceq 'docker-cli' -and $asset.bootstrapMd5) {
        if ((Get-FileHash -LiteralPath $path -Algorithm MD5).Hash.ToLowerInvariant() -cne $asset.bootstrapMd5) { throw 'Docker ZIP bootstrap MD5 mismatch. No component was staged.' }
    } else { throw "Component SHA-256 pin is missing: $($asset.id)." }
    return $sha256
}

$checked = @{}
foreach ($asset in $manifest.assets) { $checked[$asset.id] = Get-CheckedAsset $asset }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$files = [Collections.Generic.List[object]]::new()
foreach ($asset in $manifest.assets) {
    $destination = [IO.Path]::GetFullPath((Join-Path $stageRoot $asset.destination))
    if (!$destination.StartsWith(($stageRoot + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Component destination escapes the staging directory.' }
    Assert-PlainPath $destination
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
    if ($asset.zipEntry) {
        $archive = [IO.Compression.ZipFile]::OpenRead($checked[$asset.id])
        try {
            $entries = @($archive.Entries | Where-Object { $_.FullName -ceq $asset.zipEntry })
            if ($entries.Count -ne 1) { throw "Expected exactly one official ZIP entry: $($asset.zipEntry)." }
            $inputStream = $entries[0].Open()
            try {
                $outputStream = [IO.File]::Open($destination, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $inputStream.CopyTo($outputStream) }
                finally { $outputStream.Dispose() }
            } finally { $inputStream.Dispose() }
        } finally { $archive.Dispose() }
    } else { Copy-Item -LiteralPath $checked[$asset.id] -Destination $destination -Force }
    $releaseDestination = Join-Path $releaseRoot $asset.destination
    Assert-PlainPath $releaseDestination
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($releaseDestination)) -Force | Out-Null
    Copy-Item -LiteralPath $destination -Destination $releaseDestination -Force
    $files.Add([ordered]@{ file = $asset.destination; version = $asset.version; bytes = (Get-Item -LiteralPath $destination).Length; sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant(); source = $asset.url })
}
$receipt = [ordered]@{ schema = 1; platform = $manifest.platform; manifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant(); files = @($files.ToArray()); noticeScope = $manifest.noticeScope; executablesLaunched = $false }
foreach ($root in @($stageRoot, $releaseRoot)) {
    $receiptPath = Join-Path $root 'manifest.json'
    Assert-PlainPath $receiptPath
    [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}
[ordered]@{ stagePath = $stageRoot; releasePath = $releaseRoot; downloadAllowed = [bool]$AllowDownload; files = $receipt.files; executablesLaunched = $false } | ConvertTo-Json -Depth 8
