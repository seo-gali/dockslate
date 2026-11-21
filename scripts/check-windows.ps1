param([switch]$Offline)
$ErrorActionPreference='Stop'
$checkRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$previousLocation=Get-Location
$savedCargo=$env:CARGO_HOME;$savedRustup=$env:RUSTUP_HOME;$savedPath=$env:PATH
$fixture=Join-Path $checkRoot ('.analysis\process-check-'+[guid]::NewGuid().ToString('N'))
try{
 Set-Location -LiteralPath $checkRoot
 $cargo=Join-Path $checkRoot '.tools\cargo\bin\cargo.exe'
 if(Test-Path -LiteralPath $cargo){$env:CARGO_HOME=Join-Path $checkRoot '.tools\cargo';$env:RUSTUP_HOME=Join-Path $checkRoot '.tools\rustup';$env:PATH=[IO.Path]::GetDirectoryName($cargo)+';'+$env:PATH}
 & cargo.exe check --locked $(if($Offline){'--offline'}) --manifest-path src-tauri/Cargo.toml
 if($LASTEXITCODE -ne 0){throw 'Locked Rust source check failed.'}
 & cargo.exe test --locked $(if($Offline){'--offline'}) --manifest-path src-tauri/Cargo.toml security_tests -- --test-threads=1
 if($LASTEXITCODE -ne 0){throw 'Native security boundary checks failed.'}
 & (Join-Path $checkRoot 'scripts\verify-installer-path.ps1')
 if($LASTEXITCODE -ne 0){throw 'Installer PATH verification failed.'}
 $null=New-Item -ItemType Directory -Path $fixture
 $exe=Join-Path $fixture 'verify-process.exe'
 & rustc.exe --edition=2021 scripts/verify-process.rs -o $exe
 if($LASTEXITCODE -ne 0){throw 'Process verification compilation failed.'}
 & $exe $fixture
 if($LASTEXITCODE -ne 0){throw 'Process verification failed.'}
}finally{
 $env:CARGO_HOME=$savedCargo;$env:RUSTUP_HOME=$savedRustup;$env:PATH=$savedPath;Set-Location -LiteralPath $previousLocation
 if(Test-Path -LiteralPath $fixture){
  $target=[IO.Path]::GetFullPath($fixture)
  if([IO.Path]::GetDirectoryName($target) -cne (Join-Path $checkRoot '.analysis')){throw 'Invalid fixture cleanup target.'}
  if(@(Get-ChildItem -LiteralPath $target -Recurse -Force|Where-Object{$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Fixture contains a reparse point.'}
  Remove-Item -LiteralPath $target -Recurse -Force
 }
}
