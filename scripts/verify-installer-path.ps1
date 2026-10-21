$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\src-tauri\installer\user-path.ps1')
$options = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
$scratch = 'Software\DockSlate\InstallerPathVerification\' + [guid]::NewGuid().ToString('N')
$fixture = $null
$checks = [Collections.Generic.List[string]]::new()
$bin = 'C:\Program Files\DockSlate 한글\bin'

function Assert-Path([bool]$condition, [string]$message) {
    if (!$condition) { throw $message }
}

$userKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$machineKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
$beforeUser = if ($userKey) { $userKey.GetValue('Path', $null, $options) } else { $null }
$beforeMachine = $machineKey.GetValue('Path', $null, $options)
$beforeUserKind = if ($userKey -and $userKey.GetValueNames() -contains 'Path') { $userKey.GetValueKind('Path') } else { $null }
try {
    $fixture = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($scratch)
    foreach ($case in @(
        @{name='1199-character expandable PATH'; length=1199; kind='ExpandString'},
        @{name='10000-character string PATH'; length=10000; kind='String'},
        @{name='empty PATH'; length=0; kind='ExpandString'},
        @{name='absent PATH'; length=-1; kind='ExpandString'}
    )) {
        $environmentKey = $fixture.CreateSubKey($case.name + '\Environment')
        $installerKey = $fixture.CreateSubKey($case.name + '\Installer')
        try {
            $original = ''
            if ($case.length -gt 0) {
                $prefix = ';%USERPROFILE%\工具;;C:\Other App;'
                $original = $prefix + ('x' * ($case.length - $prefix.Length - 1)) + ';'
            }
            $kind = [Microsoft.Win32.RegistryValueKind]::$($case.kind)
            if ($case.length -ge 0) { $environmentKey.SetValue('Path', $original, $kind) }
            Update-DockSlateUserPath $environmentKey $installerKey check $bin
            Assert-Path ($environmentKey.GetValue('Path', $null, $options) -ceq $(if ($case.length -lt 0) { $null } else { $original })) 'Check modified PATH.'
            Update-DockSlateUserPath $environmentKey $installerKey install $bin
            $installed = $environmentKey.GetValue('Path', $null, $options)
            $expected = if ($original.Length -gt 0) { $original + ';' + $bin } else { $bin }
            Assert-Path ($installed -ceq $expected) 'Installation truncated or expanded PATH.'
            Assert-Path ($environmentKey.GetValueKind('Path') -eq $kind) 'Installation changed the registry type.'
            Update-DockSlateUserPath $environmentKey $installerKey install $bin
            Assert-Path ($environmentKey.GetValue('Path', $null, $options) -ceq $installed) 'Reinstallation duplicated PATH.'
            $environmentKey.SetValue('Path', $installed + ';C:\Added Later', $kind)
            Update-DockSlateUserPath $environmentKey $installerKey uninstall $bin
            $expected = if ($original.Length -gt 0) { $original + ';C:\Added Later' } else { 'C:\Added Later' }
            Assert-Path ($environmentKey.GetValue('Path', $null, $options) -ceq $expected) 'Removal lost unrelated PATH entries.'
            Assert-Path ($environmentKey.GetValueKind('Path') -eq $kind) 'Removal changed the registry type.'
            Assert-Path ($installerKey.ValueCount -eq 0) 'Removal left ownership values.'
            $environmentKey.DeleteValue('Path', $false)
            if ($case.length -ge 0) { $environmentKey.SetValue('Path', $original, $kind) }
            Update-DockSlateUserPath $environmentKey $installerKey install $bin
            Update-DockSlateUserPath $environmentKey $installerKey uninstall $bin
            Assert-Path ($environmentKey.GetValue('Path', $null, $options) -ceq $(if ($case.length -lt 0) { $null } else { $original })) 'Removal failed to restore the original absent/empty value.'
            $checks.Add($case.name + ': check, install, reinstall, remove, preserve subsequent edits')
        } finally { $installerKey.Dispose(); $environmentKey.Dispose() }
    }
    $environmentKey = $fixture.CreateSubKey('guards\Environment')
    $installerKey = $fixture.CreateSubKey('guards\Installer')
    try {
        $original = 'C:\Other;' + $bin.ToUpperInvariant() + ';'
        $environmentKey.SetValue('Path', $original, [Microsoft.Win32.RegistryValueKind]::String)
        Update-DockSlateUserPath $environmentKey $installerKey install $bin
        Update-DockSlateUserPath $environmentKey $installerKey uninstall $bin
        Assert-Path ($environmentKey.GetValue('Path') -ceq $original -and $installerKey.ValueCount -eq 0) 'An existing user-owned entry was changed.'
        $checks.Add('preexisting entry: case-insensitive duplicate check and ownership preservation')
        $environmentKey.SetValue('Path', 42, [Microsoft.Win32.RegistryValueKind]::DWord)
        $rejected = $false
        try { Update-DockSlateUserPath $environmentKey $installerKey install $bin } catch { $rejected = $true }
        Assert-Path ($rejected -and $environmentKey.GetValue('Path') -eq 42 -and $installerKey.ValueCount -eq 0) 'An unsupported registry value was changed.'
        $checks.Add('unsupported registry type: rejected without changes')
        $original = 'x' * 32760
        $environmentKey.SetValue('Path', $original, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        $rejected = $false
        try { Update-DockSlateUserPath $environmentKey $installerKey install $bin } catch { $rejected = $true }
        Assert-Path ($rejected -and $environmentKey.GetValue('Path', $null, $options) -ceq $original -and $installerKey.ValueCount -eq 0) 'The Windows PATH limit was not enforced before changes.'
        $checks.Add('Windows length limit: rejected without changes')
    } finally { $installerKey.Dispose(); $environmentKey.Dispose() }

    $saved = @{}
    foreach ($name in @('DOCKSLATE_PATH_SCRIPT','DOCKSLATE_PATH_MODE','DOCKSLATE_PATH_BIN')) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
    try {
        $env:DOCKSLATE_PATH_SCRIPT = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src-tauri\installer\user-path.ps1'))
        $env:DOCKSLATE_PATH_MODE = 'check'
        $env:DOCKSLATE_PATH_BIN = $bin
        & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoLogo -NoProfile -NonInteractive -Command '& ([scriptblock]::Create([IO.File]::ReadAllText($env:DOCKSLATE_PATH_SCRIPT)))'
        Assert-Path ($LASTEXITCODE -eq 0) 'The actual installer PowerShell command failed its read-only check.'
        $checks.Add('installer child process: actual user PATH read-only check')
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
    }
    $afterUser = if ($userKey) { $userKey.GetValue('Path', $null, $options) } else { $null }
    $afterUserKind = if ($userKey -and $userKey.GetValueNames() -contains 'Path') { $userKey.GetValueKind('Path') } else { $null }
    Assert-Path ($afterUser -ceq $beforeUser -and $afterUserKind -eq $beforeUserKind) 'The real user PATH changed.'
    Assert-Path ($machineKey.GetValue('Path', $null, $options) -ceq $beforeMachine) 'The real machine PATH changed.'
    [ordered]@{ passed=$true; checks=$checks.ToArray(); realUserPathUnchanged=$true; realMachinePathUnchanged=$true; engineChanged=$false } | ConvertTo-Json -Depth 4
} finally {
    if ($fixture) { $fixture.Dispose(); [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($scratch, $false) }
    if ($userKey) { $userKey.Dispose() }
    $machineKey.Dispose()
}
