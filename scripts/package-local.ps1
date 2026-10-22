param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$downloadRoot = Join-Path $projectRoot 'downloads'
$packageName = 'DockSlate-0.1.0-windows-x64'
$exeSource = Join-Path $projectRoot 'src-tauri\target\release\dockslate.exe'
$launcherSource = Join-Path $projectRoot 'src-tauri\target\release\docker.exe'
& (Join-Path $PSScriptRoot 'prepare-windows-docker.ps1') | Out-Null
$nativeRoot = Join-Path $projectRoot 'src-tauri\target\windows-docker'
$nativeManifest = Get-Content -LiteralPath (Join-Path $nativeRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$buildRecord = Join-Path $projectRoot 'docs\results\installer-engine-integration.json'
if (!(Test-Path -LiteralPath $exeSource)) { throw 'Build the Windows executable first: scripts/desktop.ps1 -Mode build' }
if (!(Test-Path -LiteralPath $launcherSource -PathType Leaf)) { throw 'Build the Docker CLI launcher first: scripts/build-cli.ps1' }
$build = Get-Content -LiteralPath $buildRecord -Raw -Encoding UTF8 | ConvertFrom-Json
$exeHash = (Get-FileHash -LiteralPath $exeSource -Algorithm SHA256).Hash
$launcherHash = (Get-FileHash -LiteralPath $launcherSource -Algorithm SHA256).Hash
if ($build.checks.windowsReleaseBuildExit -ne 0 -or $build.checks.rustCheckExit -ne 0 -or $build.checks.frontendBuildExit -ne 0) { throw 'The current integration build has not passed its source build checks.' }
foreach ($entry in @(@{ name = 'dockslate.exe'; hash = $exeHash }, @{ name = 'docker.exe'; hash = $launcherHash })) {
    $recorded = @($build.artifacts | Where-Object { $_.name -ceq $entry.name })
    if ($recorded.Count -ne 1 -or $recorded[0].sha256 -cne $entry.hash) { throw ('The executable differs from the current integration build record: ' + $entry.name) }
}
foreach ($component in $nativeManifest.files) {
    $componentPath = Join-Path $nativeRoot $component.file
    if ((Get-Item -LiteralPath $componentPath).Length -ne $component.bytes -or (Get-FileHash -LiteralPath $componentPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $component.sha256) { throw ('A native Docker component differs from its receipt: ' + $component.file) }
}

New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
$stageRoot = Join-Path $downloadRoot ('.stage-' + [guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $stageRoot $packageName
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
try {
    Copy-Item -LiteralPath $exeSource -Destination (Join-Path $packageRoot 'DockSlate.exe')
    New-Item -ItemType Directory -Path (Join-Path $packageRoot 'bin') -Force | Out-Null
    Copy-Item -LiteralPath $launcherSource -Destination (Join-Path $packageRoot 'bin\docker.exe')
    foreach ($component in $nativeManifest.files) {
        $componentDestination = Join-Path (Join-Path $packageRoot 'libexec') $component.file
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($componentDestination)) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $nativeRoot $component.file) -Destination $componentDestination
    }
    Copy-Item -LiteralPath (Join-Path $nativeRoot 'manifest.json') -Destination (Join-Path $packageRoot 'libexec\manifest.json')
    foreach ($name in @('USER_GUIDE.md', 'THIRD_PARTY_NOTICES.md')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination (Join-Path $packageRoot $name)
    }
    Copy-Item -LiteralPath (Join-Path $projectRoot 'guide.html') -Destination (Join-Path $packageRoot 'guide.html')
    $docsRoot = Join-Path $packageRoot 'docs'
    New-Item -ItemType Directory -Path $docsRoot -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'docs\REQUEST_STATUS.md') -Destination (Join-Path $docsRoot 'REQUEST_STATUS.md')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'docs\results') -Destination (Join-Path $docsRoot 'results') -Recurse
    Copy-Item -LiteralPath (Join-Path $projectRoot 'docs\research') -Destination (Join-Path $docsRoot 'research') -Recurse
    $containedArtifact = [ordered]@{
        generatedAt = (Get-Date).ToString('o'); scope = 'Complete portable ZIP requires DockSlate.exe, bin and libexec together; outer ZIP hash is in the separate SHA256SUMS.txt'
        files = @([ordered]@{file = 'DockSlate.exe'; bytes = (Get-Item -LiteralPath $exeSource).Length; sha256 = $exeHash}, [ordered]@{file = 'bin/docker.exe'; bytes = (Get-Item -LiteralPath $launcherSource).Length; sha256 = (Get-FileHash -LiteralPath $launcherSource -Algorithm SHA256).Hash}) + @($nativeManifest.files | ForEach-Object { [ordered]@{file = ('libexec/' + $_.file); bytes = $_.bytes; sha256 = $_.sha256} })
    }
    [IO.File]::WriteAllText((Join-Path $docsRoot 'results\delivery-artifacts.json'), ($containedArtifact | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    $helpText = @'
DockSlate 0.1.0 - Windows x64

1. Open guide.html for instructions and current verification limits.
2. DockSlate.exe is the desktop application. HTML files do not control WSL.
3. Requires Windows 11 x64, WSL 2.4.10+ and WebView2.
4. Extract the complete ZIP and keep DockSlate.exe, bin and libexec together.
5. bin\docker.exe is the launcher; libexec contains the official Windows CLI and plugins.

Unsigned development build. The reported security alert remains unresolved.
Do not disable protection or add an exception on this package's advice.
Deleting this folder does not unregister the WSL distribution or delete volumes.
'@
    [IO.File]::WriteAllText((Join-Path $packageRoot 'START-HERE.txt'), $helpText, [Text.UTF8Encoding]::new($false))
    $packageReadme = "# DockSlate 0.1.0`n`n[Open the HTML guide](guide.html) | [Desktop executable](DockSlate.exe) | [Request status](docs/REQUEST_STATUS.md)`n`n" + $helpText
    [IO.File]::WriteAllText((Join-Path $packageRoot 'README.md'), $packageReadme, [Text.UTF8Encoding]::new($false))
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipPath = Join-Path $downloadRoot ($packageName + '.zip')
    $tempZip = Join-Path $stageRoot 'portable.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($packageRoot, $tempZip, [IO.Compression.CompressionLevel]::Optimal, $true)
    $archive = [IO.Compression.ZipFile]::OpenRead($tempZip)
    try {
        foreach ($file in $containedArtifact.files) {
            $entryName = $packageName + '/' + $file.file.Replace('\', '/')
            $entries = @($archive.Entries | Where-Object { $_.FullName.Replace('\', '/') -ceq $entryName })
            if ($entries.Count -ne 1 -or $entries[0].Length -ne $file.bytes) { throw ('ZIP entry missing, duplicated, or incomplete: ' + $file.file) }
            $stream = $entries[0].Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $entryHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
            finally { $sha.Dispose(); $stream.Dispose() }
            if (!$entryHash.Equals($file.sha256, [StringComparison]::OrdinalIgnoreCase)) { throw ('ZIP entry hash mismatch: ' + $file.file) }
        }
    } finally { $archive.Dispose() }
    Copy-Item -LiteralPath $tempZip -Destination $zipPath -Force

    $artifacts = @(($packageName + '.zip'))
    $files = @($artifacts | ForEach-Object {
        $filePath = Join-Path $downloadRoot $_
        [ordered]@{ file = $_; bytes = (Get-Item -LiteralPath $filePath).Length; sha256 = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash }
    })
    $manifest = [ordered]@{
        generatedAt = (Get-Date).ToString('o'); version = '0.1.0'; platform = 'windows-x64'
        scope = 'Local review ZIP; no public release upload. Any existing standalone EXE was preserved and is not refreshed by this package.'; distribution = 'Complete portable ZIP with DockSlate.exe, bin and libexec'; packagingLaunchedExecutable = $false
        nativeWindowsComponentsLaunched = $false
        archiveContentVerified = $true; verifiedFiles = $containedArtifact.files.Count
        nativeUiVerificationPerformed = [bool]$build.checks.latestNativeFlowExecuted
        securityAlertResolved = $false; installerInstalledOrUninstalled = $false; files = $files
    }
    [IO.File]::WriteAllText((Join-Path $downloadRoot 'artifacts.json'), ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    $checksumText = ($files | ForEach-Object { $_.sha256 + '  ' + $_.file }) -join "`r`n"
    [IO.File]::WriteAllText((Join-Path $downloadRoot 'SHA256SUMS.txt'), ($checksumText + "`r`n"), [Text.UTF8Encoding]::new($false))
    $manifest | ConvertTo-Json -Depth 6
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stageRoot)
    $allowedPrefix = [IO.Path]::GetFullPath($downloadRoot) + [IO.Path]::DirectorySeparatorChar
    if (!$resolvedStage.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase) -or !([IO.Path]::GetFileName($resolvedStage)).StartsWith('.stage-')) {
        throw 'Refusing cleanup outside the local package staging folder.'
    }
    if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
