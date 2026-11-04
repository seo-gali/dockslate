param([Parameter(Mandatory)][string]$SessionPath)
$ErrorActionPreference='Stop'
$eventsProject=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$eventsSessionFile=[IO.Path]::GetFullPath((Join-Path $eventsProject $SessionPath))
if (!$eventsSessionFile.StartsWith((Join-Path $eventsProject '.analysis')+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'An isolated verification session under analysis is required.'}
$eventsSession=Get-Content -LiteralPath $eventsSessionFile -Raw -Encoding utf8|ConvertFrom-Json
$eventsApp=Get-Process -Id $eventsSession.pid -ErrorAction Stop
if ($eventsApp.Path -cne $eventsSession.artifact -or $eventsApp.StartTime.ToUniversalTime().Ticks.ToString() -cne $eventsSession.startedTicks) {throw 'Verification app identity differs.'}
$eventsChildren=@(Get-CimInstance Win32_Process -Filter ('ParentProcessId = '+$eventsSession.pid)|Where-Object {$_.Name -ieq 'wsl.exe' -and $_.CommandLine -and $_.CommandLine.Contains('filters = urllib.parse.quote')})
if ($eventsChildren.Count -ne 1) {throw 'Exactly one owned verification event reader required.'}
$eventsReader=Get-Process -Id $eventsChildren[0].ProcessId -ErrorAction Stop
$eventsWsl=Join-Path ([Environment]::GetFolderPath('System')) 'wsl.exe'
if ($eventsReader.Path -ine $eventsWsl) {throw 'Unexpected event reader executable.'}
Stop-Process -Id $eventsReader.Id -ErrorAction Stop
Write-Output 'Interrupted only the verification app event-reader process.'
