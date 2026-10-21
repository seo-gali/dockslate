function Update-DockSlateUserPath {
    param(
        [Microsoft.Win32.RegistryKey]$EnvironmentKey,
        [Microsoft.Win32.RegistryKey]$InstallerKey,
        [ValidateSet('check', 'install', 'uninstall')][string]$Mode,
        [string]$Bin
    )
    if (![IO.Path]::IsPathRooted($Bin) -or $Bin.Contains(';') -or $Bin.Contains([char]0)) {
        throw 'The installed bin directory cannot be represented in Windows PATH.'
    }
    $options = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    $present = $EnvironmentKey.GetValueNames() -contains 'Path'
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    $original = ''
    if ($present) {
        $kind = $EnvironmentKey.GetValueKind('Path')
        if ($kind -notin @([Microsoft.Win32.RegistryValueKind]::String, [Microsoft.Win32.RegistryValueKind]::ExpandString)) {
            throw 'The existing PATH has an unsupported registry type. It was preserved.'
        }
        $original = [string]$EnvironmentKey.GetValue('Path', '', $options)
    }
    if ($Mode -eq 'check') { return }
    $tokens = $original.Split([char]';')
    $matches = @($tokens | Where-Object { $_.Equals($Bin, [StringComparison]::OrdinalIgnoreCase) })
    if ($Mode -eq 'install') {
        if ($matches.Count -gt 0) { return }
        $result = if ($original.Length -eq 0) { $Bin } else { $original + ';' + $Bin }
        if ($result.Length -ge 32767) { throw 'Adding DockSlate would exceed the Windows PATH limit. PATH was preserved.' }
        # Record ownership before writing so an interrupted install can still remove only its entry.
        $InstallerKey.SetValue('PathEntry', $Bin, [Microsoft.Win32.RegistryValueKind]::String)
        $InstallerKey.SetValue('PathAdded', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
        $InstallerKey.SetValue('PathWasPresent', [int]$present, [Microsoft.Win32.RegistryValueKind]::DWord)
        $EnvironmentKey.SetValue('Path', $result, $kind)
        if ($EnvironmentKey.GetValue('Path', $null, $options) -cne $result -or $EnvironmentKey.GetValueKind('Path') -ne $kind) {
            throw 'Windows PATH registration could not be verified.'
        }
        return
    }
    if ($InstallerKey.GetValue('PathAdded', 0) -ne 1 -or
        !([string]$InstallerKey.GetValue('PathEntry', '')).Equals($Bin, [StringComparison]::OrdinalIgnoreCase)) { return }
    if ($matches.Count -gt 0) {
        $retained = @($tokens | Where-Object { ! $_.Equals($Bin, [StringComparison]::OrdinalIgnoreCase) })
        if ($retained.Count -eq 0 -and $InstallerKey.GetValue('PathWasPresent', 1) -eq 0) {
            $EnvironmentKey.DeleteValue('Path', $false)
        } else {
            $result = $retained -join ';'
            $EnvironmentKey.SetValue('Path', $result, $kind)
            if ($EnvironmentKey.GetValue('Path', $null, $options) -cne $result -or $EnvironmentKey.GetValueKind('Path') -ne $kind) {
                throw 'Windows PATH removal could not be verified.'
            }
        }
    }
    foreach ($name in @('PathEntry', 'PathAdded', 'PathWasPresent')) { $InstallerKey.DeleteValue($name, $false) }
}

if ($MyInvocation.InvocationName -eq '.') { return }
$ErrorActionPreference = 'Stop'
$environmentKey = $null
$installerKey = $null
try {
    $mode = $env:DOCKSLATE_PATH_MODE
    if ($mode -notin @('check', 'install', 'uninstall')) { throw 'Unsupported installer PATH operation.' }
    $writable = $mode -ne 'check'
    $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $writable)
    if (!$environmentKey) {
        if ($mode -ne 'install') { exit 0 }
        $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    }
    if ($mode -eq 'install') {
        $installerKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\DockSlate\Installer')
    } elseif ($mode -eq 'uninstall') {
        $installerKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\DockSlate\Installer', $true)
        if (!$installerKey) { exit 0 }
    }
    Update-DockSlateUserPath -EnvironmentKey $environmentKey -InstallerKey $installerKey -Mode $mode -Bin $env:DOCKSLATE_PATH_BIN
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($installerKey) { $installerKey.Dispose() }
    if ($environmentKey) { $environmentKey.Dispose() }
}
