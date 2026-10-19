[CmdletBinding()]
param(
    [switch]$AllowToolDownload,
    [switch]$SkipBuild,
    [switch]$CheckToolsOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cliRoot = Join-Path $projectRoot 'node_modules\@tauri-apps\cli'
$cliManifest = Join-Path $cliRoot 'package.json'
if (!(Test-Path -LiteralPath $cliManifest -PathType Leaf)) {
    throw 'The existing local Tauri CLI is missing. No package installation was attempted.'
}
$cliVersion = (Get-Content -LiteralPath $cliManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($cliVersion -ne '2.12.2') {
    throw "Installer tool-cache checks target the installed Tauri CLI 2.12.2; found $cliVersion. Review its official bundler source before changing this script."
}
$targetRoot = Join-Path $projectRoot 'src-tauri\target'
$toolRoot = Join-Path $targetRoot '.tauri\NSIS'
$requiredFiles = @(
    'makensis.exe', 'Bin\makensis.exe', 'Stubs\lzma-x86-unicode',
    'Stubs\lzma_solid-x86-unicode', 'Plugins\x86-unicode\additional\nsis_tauri_utils.dll',
    'Plugins\x86-unicode\System.dll', 'Plugins\x86-unicode\NSISdl.dll',
    'Plugins\x86-unicode\StartMenu.dll', 'Plugins\x86-unicode\nsDialogs.dll',
    'Include\MUI2.nsh', 'Include\FileFunc.nsh', 'Include\x64.nsh',
    'Include\nsDialogs.nsh', 'Include\WinMessages.nsh', 'Include\Win\COM.nsh',
    'Include\Win\Propkey.nsh', 'Include\Win\RestartManager.nsh',
    'Include\LogicLib.nsh', 'Include\WordFunc.nsh', 'Include\StrFunc.nsh'
)
$missing = @($requiredFiles | Where-Object { !(Test-Path -LiteralPath (Join-Path $toolRoot $_) -PathType Leaf) })
$utilityPath = Join-Path $toolRoot 'Plugins\x86-unicode\additional\nsis_tauri_utils.dll'
$utilityHashMatches = (Test-Path -LiteralPath $utilityPath -PathType Leaf) -and ((Get-FileHash -LiteralPath $utilityPath -Algorithm SHA1).Hash -eq '75197FEE3C6A814FE035788D1C34EAD39349B860')
$toolsReady = $missing.Count -eq 0 -and $utilityHashMatches
$toolStatus = [ordered]@{
    tauriCliVersion = $cliVersion
    cachePath = $toolRoot
    toolsReady = $toolsReady
    missingFiles = $missing
    tauriUtilityHashMatches = $utilityHashMatches
    officialSource = 'https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs'
    requiredDownloads = @(
        'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip',
        'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll'
    )
    downloadsAllowed = [bool]$AllowToolDownload
    installerExecuted = $false
}
if ($CheckToolsOnly) {
    $toolStatus | ConvertTo-Json -Depth 4
    return
}
if (!$toolsReady -and !$AllowToolDownload) {
    $toolStatus | ConvertTo-Json -Depth 4
    throw 'NSIS 3.11 and the Tauri NSIS utility are not fully cached. No download or build was started. After explicit download approval, rerun with -AllowToolDownload.'
}

$processVariables = @('CARGO_HOME', 'RUSTUP_HOME', 'PATH', 'CARGO_NET_OFFLINE', 'CARGO_TARGET_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')
$savedVariables = @{}
foreach ($name in $processVariables) { $savedVariables[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$previousLocation = Get-Location
try {
    Set-Location -LiteralPath $projectRoot
    $localCargo = Join-Path $projectRoot '.tools\cargo\bin\cargo.exe'
    if (Test-Path -LiteralPath $localCargo -PathType Leaf) {
        $env:CARGO_HOME = Join-Path $projectRoot '.tools\cargo'
        $env:RUSTUP_HOME = Join-Path $projectRoot '.tools\rustup'
        $env:PATH = [IO.Path]::GetDirectoryName($localCargo) + ';' + $env:PATH
    } elseif (!(Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
        throw 'Rust MSVC is missing. No Rust toolchain download was attempted.'
    }
    $env:CARGO_NET_OFFLINE = 'true'
    $env:CARGO_TARGET_DIR = $targetRoot
    if (!$AllowToolDownload) {
        $env:HTTP_PROXY = 'http://127.0.0.1:9'
        $env:HTTPS_PROXY = 'http://127.0.0.1:9'
        $env:ALL_PROXY = 'http://127.0.0.1:9'
        $env:NO_PROXY = ''
    }
    $cliEntry = Join-Path $cliRoot 'tauri.js'
    if (!$SkipBuild) {
        $launcherBuilder = Join-Path $PSScriptRoot 'build-cli.ps1'
        if (!(Test-Path -LiteralPath $launcherBuilder -PathType Leaf)) { throw 'The local Docker CLI launcher build script is missing.' }
        & $launcherBuilder
        if ($LASTEXITCODE -ne 0) { throw "Docker CLI launcher build failed (exit $LASTEXITCODE)." }
        & node.exe $cliEntry build --no-bundle --ci -- --locked --offline
        if ($LASTEXITCODE -ne 0) { throw "DockSlate build failed (exit $LASTEXITCODE)." }
    }
    foreach ($binary in @('dockslate.exe', 'docker.exe')) {
        if (!(Test-Path -LiteralPath (Join-Path $targetRoot "release\$binary") -PathType Leaf)) {
            throw "Missing release executable $binary. Build the app and CLI launcher before bundling."
        }
    }
    $guideSource = [IO.File]::ReadAllText((Join-Path $projectRoot 'guide.html'))
    $guideMarker = "const packaged = location.pathname.includes('/DockSlate-0.1.0-windows-x64/');"
    if (!$guideSource.Contains($guideMarker)) { throw 'The standalone guide marker is missing.' }
    $installerResources = Join-Path $targetRoot 'installer-resources'
    New-Item -ItemType Directory -Path $installerResources -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $installerResources 'guide.html'), $guideSource.Replace($guideMarker, 'const packaged = true;'), [Text.UTF8Encoding]::new($false))
    & node.exe $cliEntry bundle --bundles nsis --config src-tauri/tauri.installer.conf.json --no-binary-patching --ci
    if ($LASTEXITCODE -ne 0) { throw "NSIS bundling failed (exit $LASTEXITCODE). No installer was executed." }
    $version = (Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $installer = Join-Path $targetRoot "release\bundle\nsis\DockSlate_${version}_x64-setup.exe"
    if (!(Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'The NSIS command completed without the expected x64 installer.' }
    [ordered]@{
        installerPath = $installer
        bytes = (Get-Item -LiteralPath $installer).Length
        sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
        installerExecuted = $false
        runtimeInstalled = $false
    } | ConvertTo-Json
} finally {
    Set-Location -LiteralPath $previousLocation
    foreach ($name in $processVariables) { [Environment]::SetEnvironmentVariable($name, $savedVariables[$name], 'Process') }
}
