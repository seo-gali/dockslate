$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'seo-gali/dockslate') { throw 'One-shot GitHub build only.' }
if ((Get-Content package.json -Raw | ConvertFrom-Json).version -cne '0.1.18') { throw 'Unexpected version.' }
New-Item -ItemType Directory -Path .analysis -Force | Out-Null
$env:LOCALAPPDATA = Join-Path $PWD '.analysis/native-build-profile'
New-Item -ItemType Directory -Path $env:LOCALAPPDATA -Force | Out-Null
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Locked npm installation failed.' }
& npm.cmd run check
if ($LASTEXITCODE -ne 0) { throw 'Source checks failed.' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
& cargo.exe fetch --manifest-path src-tauri/Cargo.toml --locked
if ($LASTEXITCODE -ne 0) { throw 'Locked cargo fetch failed.' }
& ./scripts/prepare-windows-docker.ps1 -AllowDownload
& node.exe scripts/verify-license-inventory.mjs
if ($LASTEXITCODE -ne 0) { throw 'License inventory failed.' }
& cargo.exe check --manifest-path src-tauri/Cargo.toml --locked --offline
if ($LASTEXITCODE -ne 0) { throw 'Rust check failed.' }
& cargo.exe test --manifest-path src-tauri/Cargo.toml --locked --offline -- --test-threads=1
if ($LASTEXITCODE -ne 0) { throw 'Rust tests failed.' }
$env:DOCKER_CONFIG = Join-Path $PWD '.analysis/compose-config-build'
New-Item -ItemType Directory -Path $env:DOCKER_CONFIG | Out-Null
$env:DOCKSLATE_TEST_COMPOSE = Join-Path $PWD 'src-tauri/target/windows-docker/cli-plugins/docker-compose.exe'
$composeRecord = (Get-Content src-tauri/target/windows-docker/manifest.json -Raw | ConvertFrom-Json).files | Where-Object file -CEQ 'cli-plugins/docker-compose.exe'
if ((Get-FileHash -LiteralPath $env:DOCKSLATE_TEST_COMPOSE).Hash.ToLowerInvariant() -cne $composeRecord.sha256) { throw 'Compose tool changed.' }
& cargo.exe test --manifest-path src-tauri/Cargo.toml --locked --offline configuration_matches_offline_compose -- --ignored --test-threads=1
if ($LASTEXITCODE -ne 0) { throw 'Offline Compose configuration check failed.' }
& ./scripts/build-cli.ps1
if ($LASTEXITCODE -ne 0) { throw 'CLI build failed.' }
& npm.cmd run desktop:build -- --ci -- --locked --offline
if ($LASTEXITCODE -ne 0) { throw 'Release application build failed.' }
& "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -NonInteractive -File scripts/verify-installer-path.ps1
if ($LASTEXITCODE -ne 0) { throw 'PATH fixture check failed.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$toolZip = Join-Path $PWD '.analysis/nsis-3.11.zip'
$toolDll = Join-Path $PWD '.analysis/nsis_tauri_utils.dll'
Invoke-WebRequest -Uri 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip' -OutFile $toolZip -TimeoutSec 180
if ((Get-FileHash -LiteralPath $toolZip).Hash -cne 'C7D27F780DDB6CFFB4730138CD1591E841F4B7EDB155856901CDF5F214394FA1') { throw 'Official NSIS archive SHA-256 mismatch.' }
Invoke-WebRequest -Uri 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll' -OutFile $toolDll -TimeoutSec 180
if ((Get-FileHash -LiteralPath $toolDll).Hash -cne '5BA143B5DB4A87D32D6E7802E033330AAE56CBCEABE0D1E3BA41948385AD4709') { throw 'Official NSIS utility SHA-256 mismatch.' }
$toolStage = Join-Path $PWD '.analysis/nsis-unpacked'
[IO.Compression.ZipFile]::ExtractToDirectory($toolZip, $toolStage)
$nsisSource = Join-Path $toolStage 'nsis-3.11'
if (!(Test-Path -LiteralPath (Join-Path $nsisSource 'makensis.exe'))) { throw 'Unexpected official NSIS archive layout.' }
$toolRoot = Join-Path $PWD 'src-tauri/target/.tauri/NSIS'
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($toolRoot)) -Force | Out-Null
Copy-Item -LiteralPath $nsisSource -Destination $toolRoot -Recurse
$pluginRoot = Join-Path $toolRoot 'Plugins/x86-unicode/additional'
New-Item -ItemType Directory -Path $pluginRoot -Force | Out-Null
Copy-Item -LiteralPath $toolDll -Destination (Join-Path $pluginRoot 'nsis_tauri_utils.dll')
& node.exe .github/release018-record-build.mjs
if ($LASTEXITCODE -ne 0) { throw 'Build receipt failed.' }
& ./scripts/build-installer.ps1 -SkipBuild
if ($LASTEXITCODE -ne 0) { throw 'Installer packaging failed.' }
$legal = Join-Path $PWD 'downloads/DockSlate-0.1.18-third-party-licenses.zip'
if (Test-Path -LiteralPath $legal) { throw 'Preserve existing release files.' }
[IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $PWD 'licenses'), $legal, [IO.Compression.CompressionLevel]::Optimal, $false)
Copy-Item -LiteralPath 'src-tauri/target/release/bundle/nsis/DockSlate_0.1.18_x64-setup.exe' -Destination 'downloads/DockSlate_0.1.18_x64-setup.exe'
& ./scripts/package-local.ps1
if ($LASTEXITCODE -ne 0) { throw 'Portable packaging failed.' }
$files = @('DockSlate_0.1.18_x64-setup.exe', 'DockSlate-0.1.18-windows-x64.zip', 'DockSlate-0.1.18-third-party-licenses.zip')
$sums = ($files | ForEach-Object { (Get-FileHash -LiteralPath ('downloads/' + $_)).Hash + '  ' + $_ }) -join "`n"
[IO.File]::WriteAllText('downloads/SHA256SUMS.txt', $sums + "`n", [Text.UTF8Encoding]::new($false))
