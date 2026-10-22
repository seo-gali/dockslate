[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$SignedReference)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$verifier = Join-Path $PSScriptRoot 'verify-code-signatures.ps1'
$reference = Get-AuthenticodeSignature -LiteralPath $SignedReference
if ($reference.Status -ne 'Valid' -or $null -eq $reference.TimeStamperCertificate) {
    throw 'A real trusted, timestamped executable is required; no certificates will be created or installed.'
}
$subject = $reference.SignerCertificate.Subject
$installer = Join-Path $projectRoot 'downloads\DockSlate_0.1.0_x64-setup.exe'
$archive = Join-Path $projectRoot 'downloads\DockSlate-0.1.0-windows-x64.zip'
$before = @($installer, $archive | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash })
$report = [ordered]@{ observedAt = (Get-Date).ToString('o'); completed = $false; targetExecutablesLaunched = $false; checks = @(); failure = $null }
$previousSubject = $env:DOCKSLATE_SIGNER_SUBJECT
$fixtureRoot = $null
function Check-Rejected([string]$Name, [scriptblock]$Action, [string]$Reason) {
    $failure = $null
    try { & $Action | Out-Null } catch { $failure = $_.Exception.Message }
    if (!$failure -or !$failure.Contains($Reason)) { throw "Expected rejection missing: $Name ($failure)" }
    $report.checks += [pscustomobject]@{ name = $Name; passed = $true; rejection = $failure }
}
try {
    $valid = & $verifier -Path $SignedReference -ExpectedSubject $subject
    if ($valid.status -ne 'Valid' -or !$valid.timestamped) { throw 'Trusted reference did not pass.' }
    $report.checks += [pscustomobject]@{ name = 'Trusted timestamped reference accepted'; passed = $true; evidence = $valid }
    Check-Rejected 'Missing identity rejected' { & $verifier -Path $SignedReference -ExpectedSubject '' } 'not configured'
    Check-Rejected 'Different publisher rejected' { & $verifier -Path $SignedReference -ExpectedSubject 'CN=Wrong Publisher' } 'different publisher'
    Check-Rejected 'Actual unsigned installer rejected' { & $verifier -Path $installer -ExpectedSubject $subject } 'NotSigned'
    Check-Rejected 'Missing file rejected' { & $verifier -Path (Join-Path $projectRoot '.analysis\no-such-signing-file.exe') -ExpectedSubject $subject } 'Missing executable'
    Check-Rejected 'Batch containing unsigned installer rejected' { & $verifier -Path @($SignedReference, $installer) -ExpectedSubject $subject } 'NotSigned'
    $fixtureRoot = Join-Path $projectRoot ('.analysis\signature-check-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    $tampered = Join-Path $fixtureRoot 'tampered-signtool.exe'
    $bytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $SignedReference).ProviderPath)
    $bytes[1024] = $bytes[1024] -bxor 1
    [IO.File]::WriteAllBytes($tampered, $bytes)
    Check-Rejected 'Modified signed copy rejected' { & $verifier -Path $tampered -ExpectedSubject $subject } 'HashMismatch'
    $env:DOCKSLATE_SIGNER_SUBJECT = ''
    Check-Rejected 'Installer entry blocks missing identity before build' { & (Join-Path $PSScriptRoot 'build-installer.ps1') -SkipBuild } 'not configured'
    Check-Rejected 'ZIP entry blocks missing identity before packaging' { & (Join-Path $PSScriptRoot 'package-local.ps1') } 'not configured'
    $env:DOCKSLATE_SIGNER_SUBJECT = $subject
    Check-Rejected 'Configured subject cannot make unsigned ZIP payload pass' { & (Join-Path $PSScriptRoot 'package-local.ps1') } 'NotSigned'
    $after = @($installer, $archive | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash })
    if (($before -join ',') -cne ($after -join ',')) { throw 'An existing installer or ZIP was modified.' }
    $report.checks += [pscustomobject]@{ name = 'Existing installer and ZIP remain unchanged'; passed = $true; sha256 = $after }
    $report.completed = $true
} catch { $report.failure = $_.Exception.Message; throw }
finally {
    $env:DOCKSLATE_SIGNER_SUBJECT = $previousSubject
    if ($fixtureRoot) {
        $allowedPrefix = [IO.Path]::GetFullPath((Join-Path $projectRoot '.analysis')) + [IO.Path]::DirectorySeparatorChar
        if (![IO.Path]::GetFullPath($fixtureRoot).StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing fixture cleanup outside .analysis.' }
        Remove-Item -LiteralPath (Join-Path $fixtureRoot 'tampered-signtool.exe') -Force
        Remove-Item -LiteralPath $fixtureRoot
    }
    $json = $report | ConvertTo-Json -Depth 7
    [IO.File]::WriteAllText((Join-Path $projectRoot 'docs\results\code-signing-verification.json'), $json + "`n", [Text.UTF8Encoding]::new($false))
    Write-Output $json
}
