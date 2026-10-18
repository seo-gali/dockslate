param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$downloadRoot = Join-Path $projectRoot 'downloads'
$packageName = 'DockSlate-0.1.0-windows-x64'
$exeSource = Join-Path $projectRoot 'src-tauri\target\release\dockslate.exe'
$buildRecord = Join-Path $projectRoot 'docs\results\refinement-build.json'
if (!(Test-Path -LiteralPath $exeSource)) { throw 'Build the Windows executable first: scripts/desktop.ps1 -Mode build' }
$build = Get-Content -LiteralPath $buildRecord -Raw -Encoding UTF8 | ConvertFrom-Json
$exeHash = (Get-FileHash -LiteralPath $exeSource -Algorithm SHA256).Hash
if ($exeHash -ne $build.sha256) { throw 'The executable differs from the recorded build. Update the build record after verification.' }

New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
$stageRoot = Join-Path $downloadRoot ('.stage-' + [guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $stageRoot $packageName
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
try {
    Copy-Item -LiteralPath $exeSource -Destination (Join-Path $packageRoot 'DockSlate.exe')
    foreach ($name in @('USER_GUIDE.md', 'THIRD_PARTY_NOTICES.md')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination (Join-Path $packageRoot $name)
    }
    $guideSource = [IO.File]::ReadAllText((Join-Path $projectRoot 'guide.html'))
    $packageMarker = "const packaged = location.pathname.includes('/DockSlate-0.1.0-windows-x64/');"
    if (!$guideSource.Contains($packageMarker)) { throw 'Portable guide marker is missing.' }
    [IO.File]::WriteAllText((Join-Path $packageRoot 'guide.html'), $guideSource.Replace($packageMarker, 'const packaged = true;'), [Text.UTF8Encoding]::new($false))
    $docsRoot = Join-Path $packageRoot 'docs'
    New-Item -ItemType Directory -Path $docsRoot -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'docs\REQUEST_STATUS.md') -Destination (Join-Path $docsRoot 'REQUEST_STATUS.md')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'docs\results') -Destination (Join-Path $docsRoot 'results') -Recurse
    Copy-Item -LiteralPath (Join-Path $projectRoot 'docs\research') -Destination (Join-Path $docsRoot 'research') -Recurse
    $containedArtifact = [ordered]@{
        generatedAt = (Get-Date).ToString('o'); scope = 'Contained executable only; outer ZIP hash is in the separate SHA256SUMS.txt'
        files = @([ordered]@{file = 'DockSlate.exe'; bytes = (Get-Item -LiteralPath $exeSource).Length; sha256 = $exeHash})
    }
    [IO.File]::WriteAllText((Join-Path $docsRoot 'results\delivery-artifacts.json'), ($containedArtifact | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    $helpText = @'
DockSlate 0.1.0 - Windows x64

1. Open guide.html for instructions and current verification limits.
2. DockSlate.exe is the desktop application. HTML files do not control WSL.
3. Requires Windows 11 x64, WSL 2.4.10+ and WebView2.

Development build, unsigned. The reported security alert remains unresolved.
Do not disable protection or add an exception on this package's advice.
Deleting this folder does not unregister the WSL distribution or delete volumes.
'@
    [IO.File]::WriteAllText((Join-Path $packageRoot 'START-HERE.txt'), $helpText, [Text.UTF8Encoding]::new($false))
    $packageReadme = "# DockSlate 0.1.0`n`n[Open the HTML guide](guide.html) | [Desktop executable](DockSlate.exe) | [Request status](docs/REQUEST_STATUS.md)`n`n" + $helpText
    [IO.File]::WriteAllText((Join-Path $packageRoot 'README.md'), $packageReadme, [Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath $exeSource -Destination (Join-Path $downloadRoot 'DockSlate.exe') -Force
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipPath = Join-Path $downloadRoot ($packageName + '.zip')
    $tempZip = Join-Path $stageRoot 'portable.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($packageRoot, $tempZip, [IO.Compression.CompressionLevel]::Optimal, $true)
    Copy-Item -LiteralPath $tempZip -Destination $zipPath -Force

    $artifacts = @('DockSlate.exe', ($packageName + '.zip'))
    $files = @($artifacts | ForEach-Object {
        $filePath = Join-Path $downloadRoot $_
        [ordered]@{ file = $_; bytes = (Get-Item -LiteralPath $filePath).Length; sha256 = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash }
    })
    $manifest = [ordered]@{
        generatedAt = (Get-Date).ToString('o'); version = '0.1.0'; platform = 'windows-x64'
        scope = 'Local review package; no public release upload'; distribution = 'Portable EXE and ZIP only, selected by user'; packagingLaunchedExecutable = $false
        nativeUiVerificationPerformed = [bool]$build.nativeLaunchedAfterBrowsingDataAlert
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
