param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
& (Join-Path $PSScriptRoot 'prepare-windows-docker.ps1') | Out-Null
$localCargo = Join-Path $projectRoot '.tools\cargo\bin\cargo.exe'
if (Test-Path -LiteralPath $localCargo -PathType Leaf) {
    $env:CARGO_HOME = Join-Path $projectRoot '.tools\cargo'
    $env:RUSTUP_HOME = Join-Path $projectRoot '.tools\rustup'
    $env:PATH = [IO.Path]::GetDirectoryName($localCargo) + ';' + $env:PATH
} elseif (!(Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
    throw 'Existing Rust MSVC tools are required; this script does not download tools.'
}

Push-Location -LiteralPath $projectRoot
try {
    & cargo.exe build --manifest-path src-tauri/Cargo.toml --bin docker --release --locked --offline
    if ($LASTEXITCODE -ne 0) { throw "DockSlate CLI build failed (exit $LASTEXITCODE)." }
    $binary = Join-Path $projectRoot 'src-tauri\target\release\docker.exe'
    $item = Get-Item -LiteralPath $binary
    [pscustomobject]@{ path = $item.FullName; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash; launched = $false } | ConvertTo-Json
} finally {
    Pop-Location
}
