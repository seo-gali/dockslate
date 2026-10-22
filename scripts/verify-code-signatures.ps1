[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string[]]$Path,
    [string]$ExpectedSubject = $env:DOCKSLATE_SIGNER_SUBJECT
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($ExpectedSubject)) {
    throw 'DOCKSLATE_SIGNER_SUBJECT is not configured. Distribution is blocked; no signing identity has been selected.'
}
if ($Path.Count -eq 0) { throw 'At least one executable is required for signature verification.' }
foreach ($file in $Path) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing executable: $file" }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode') {
        throw "Distribution blocked: $file has no valid embedded Authenticode signature ($($signature.Status))."
    }
    if (![string]::Equals($signature.SignerCertificate.Subject, $ExpectedSubject, [StringComparison]::Ordinal)) {
        throw "Distribution blocked: $file was signed by a different publisher."
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        throw "Distribution blocked: $file has no verified signing timestamp."
    }
    [pscustomobject]@{
        file = [IO.Path]::GetFullPath($file)
        status = [string]$signature.Status
        subject = $signature.SignerCertificate.Subject
        thumbprint = $signature.SignerCertificate.Thumbprint
        timestamped = $true
        sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    }
}
