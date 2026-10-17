param([ValidateSet('dev', 'build', 'verify')][string]$Mode = 'dev')

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$localCargo = Join-Path $projectRoot '.tools\cargo\bin\cargo.exe'
if (Test-Path -LiteralPath $localCargo) {
    $env:CARGO_HOME = Join-Path $projectRoot '.tools\cargo'
    $env:RUSTUP_HOME = Join-Path $projectRoot '.tools\rustup'
    $env:PATH = [IO.Path]::GetDirectoryName($localCargo) + ';' + $env:PATH
} elseif (!(Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
    throw 'Rust MSVC is required. Install Rust and Microsoft C++ Build Tools before running DockSlate.'
}
if ($Mode -eq 'verify') {
    $exe = Join-Path $projectRoot 'src-tauri\target\release\dockslate.exe'
    if (!(Test-Path -LiteralPath $exe)) { throw 'Build the Windows executable first.' }
    $verify = Start-Process -FilePath $exe -ArgumentList @('--verify-read-only','docs/results/native-verification.json') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    if (!$verify.WaitForExit(120000)) { throw 'Read-only verification is still running; no destructive operation was requested.' }
    if ($verify.ExitCode -ne 0) { throw 'Read-only native verification failed.' }
    Get-Content -LiteralPath 'docs/results/native-verification.json' -Raw -Encoding UTF8
    exit 0
}
$scriptName = if ($Mode -eq 'build') { 'desktop:build' } else { 'desktop:dev' }
& npm.cmd run $scriptName
if ($LASTEXITCODE -ne 0) { throw "DockSlate $Mode failed (exit $LASTEXITCODE)." }
