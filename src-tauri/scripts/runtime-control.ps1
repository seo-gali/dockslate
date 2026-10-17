$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Environment]::GetEnvironmentVariable('DOCKSLATE_RUNTIME_REQUEST') | ConvertFrom-Json
$distribution = 'DockSlate'
$rootfsUrl = 'https://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-wsl-amd64.wsl'
$rootfsHash = 'bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e'
$engineVersion = '5:29.8.2-1~ubuntu.24.04~noble'
$wsl = Join-Path ([Environment]::GetFolderPath('System')) 'wsl.exe'
$powershell = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
$runtimeRoot = $null
$installPath = $null
$script:operation = $null
$script:ownsOperation = $false
$script:mutationLock = $null
$script:runtimeDirectoryHandle = $null

function Normalize-Path([string]$path) {
    if ($path.StartsWith('\\?\')) { $path = $path.Substring(4) }
    if ($path -notmatch '^[A-Za-z]:\\' -or $path.Substring(2).Contains(':')) { throw 'A local absolute drive path is required for the owned runtime.' }
    return [IO.Path]::GetFullPath($path).TrimEnd('\')
}

function Assert-PlainPath([string]$path) {
    $cursor = Normalize-Path $path
    while ($cursor) {
        if ([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Runtime paths and their ancestors must not be links or reparse points.' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if (!$parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Read-OwnedJson([string]$name) {
    $path = Join-Path $runtimeRoot $name
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    Assert-PlainPath $path
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]([IO.FileShare]::Read -bor [IO.FileShare]::Delete))
    try {
        if ($stream.Length -le 0 -or $stream.Length -gt 131072) { throw 'The owned runtime metadata has an unsupported size.' }
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true, 4096)
        try { return $reader.ReadToEnd() | ConvertFrom-Json }
        finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

function Write-OwnedJson([string]$name, $value) {
    if ($null -eq $value) { throw 'Owned runtime metadata must not be null.' }
    $path = Join-Path $runtimeRoot $name
    Assert-PlainPath $runtimeRoot
    Assert-PlainPath $path
    $temporary = Join-Path $runtimeRoot ($name + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Depth 15 -Compress), [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporary, $path, [Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temporary, $path) }
}

function Lock-OwnedRuntime {
    $path = Join-Path $runtimeRoot 'mutation.lock'
    Assert-PlainPath $path
    if (!('DockSlateRuntimeLock' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DockSlateRuntimeLock {
    [StructLayout(LayoutKind.Sequential)] private struct FileInfo {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    private static SafeFileHandle Open(string path, bool directory) {
        var handle = CreateFile(path, directory ? 0x80000000u : 0xc0000000u,
            directory ? 3u : 0u, IntPtr.Zero, directory ? 3u : 4u,
            0x00200000u | (directory ? 0x02000000u : 0u), IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
        FileInfo info;
        if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x400u) != 0 ||
            ((info.Attributes & 0x10u) != 0) != directory || (!directory && info.Links != 1)) {
            handle.Dispose(); throw new IOException("Runtime locks require plain paths without reparse points or hard links.");
        }
        return handle;
    }
    public static SafeFileHandle PinDirectory(string path) { return Open(path, true); }
    public static FileStream Acquire(string path) { return new FileStream(Open(path, false), FileAccess.ReadWrite); }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment,
        string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    public static Process StartKeeper(string program) {
        var startup = new StartupInfo();
        startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfo));
        ProcessInfo process;
        var command = new StringBuilder("\"" + program + "\" --distribution DockSlate --user root --exec /usr/local/libexec/dockslate-keepalive");
        if (!CreateProcess(program, command, IntPtr.Zero, IntPtr.Zero, false, 0x08000000u,
            IntPtr.Zero, null, ref startup, out process)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try { return Process.GetProcessById((int)process.ProcessId); }
        finally { CloseHandle(process.Thread); CloseHandle(process.Process); }
    }
}
'@
    }
    try {
        $script:runtimeDirectoryHandle = [DockSlateRuntimeLock]::PinDirectory($runtimeRoot)
        Assert-PlainPath $path
        $script:mutationLock = [DockSlateRuntimeLock]::Acquire($path)
    }
    catch { throw 'Another DockSlate instance or disk operation holds the owned runtime mutation lock. No WSL changes were started.' }
}

function Quote-Argument([string]$value) {
    if ($value.Contains([char]0)) { throw 'The fixed command argument is invalid.' }
    if ($value.Length -gt 0 -and $value -notmatch '[\s"]') { return $value }
    return '"' + [regex]::Replace([regex]::Replace($value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Invoke-FixedWsl([string[]]$arguments, [bool]$readOnly = $false, [string]$inputText = $null) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $wsl
    $info.Arguments = ($arguments | ForEach-Object { Quote-Argument $_ }) -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = if ($readOnly) { [Text.Encoding]::Unicode } else { [Text.Encoding]::UTF8 }
    $info.StandardErrorEncoding = $info.StandardOutputEncoding
    $info.RedirectStandardInput = $true
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $info
    $started = $false
    try {
        if (!$child.Start()) { throw 'The fixed WSL command could not start.' }
        $started = $true
        $outTask = $child.StandardOutput.ReadToEndAsync()
        $errTask = $child.StandardError.ReadToEndAsync()
        if ($inputText) { $child.StandardInput.Write($inputText) }
        $child.StandardInput.Close()
        if ($readOnly) {
            if (!$child.WaitForExit(15000)) { $child.Kill(); throw 'The read-only WSL inventory timed out. Runtime state remains unverified.' }
        } else {
            if ($ownsOperation) {
                $operation.childProcessId = $child.Id
                $operation.childStartedTicks = $child.StartTime.ToUniversalTime().Ticks.ToString()
                Write-OwnedJson 'operation.json' $operation
            }
            $child.WaitForExit()
        }
        $stdout = $outTask.GetAwaiter().GetResult()
        $stderr = $errTask.GetAwaiter().GetResult()
        if ($stdout.Length -gt 1048576 -or $stderr.Length -gt 1048576) { throw 'The fixed runtime command produced excessive output. Its result is unverified.' }
        if ($child.ExitCode -ne 0) { throw ('The fixed WSL command failed (exit ' + $child.ExitCode + '). ' + ($stderr -replace '\s+', ' ').Substring(0, [Math]::Min(1200, ($stderr -replace '\s+', ' ').Length))) }
        return $stdout.Replace([string][char]0, '').Trim([char]0xFEFF)
    } finally {
        if ($started -and !$readOnly -and !$child.HasExited) { $child.WaitForExit() }
        $child.Dispose()
    }
}

function Get-Registrations {
    $entries = [Collections.Generic.List[object]]::new()
    $registry = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Lxss', $false)
    if (!$registry) { return @() }
    try {
        foreach ($id in $registry.GetSubKeyNames()) {
            $entry = $registry.OpenSubKey($id, $false)
            if (!$entry) { throw 'WSL registration inventory cannot be verified.' }
            try {
                $entries.Add([pscustomobject]@{ id = $id; name = [string]$entry.GetValue('DistributionName'); basePath = [Environment]::ExpandEnvironmentVariables([string]$entry.GetValue('BasePath')); version = $entry.GetValue('Version', 0); vhdFileName = [string]$entry.GetValue('VhdFileName', 'ext4.vhdx') })
            } finally { $entry.Dispose() }
        }
    } finally { $registry.Dispose() }
    return @($entries.ToArray())
}

function Get-Running {
    $text = Invoke-FixedWsl @('--list', '--running', '--quiet') $true
    return @($text -split '[\r\n]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Test-TrackedProcess($record, [string]$program) {
    if (!$record -or !$record.processId -or !$record.startedTicks) { return $false }
    $process = $null
    try {
        $process = [Diagnostics.Process]::GetProcessById([int]$record.processId)
        return !$process.HasExited -and $process.StartTime.ToUniversalTime().Ticks.ToString() -ceq [string]$record.startedTicks -and [string]::Equals((Normalize-Path $process.MainModule.FileName), (Normalize-Path $program), [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
    finally { if ($process) { $process.Dispose() } }
}

function Get-Operation {
    $record = Read-OwnedJson 'operation.json'
    if (!$record) { return $null }
    if ($record.state -in @('installing', 'starting', 'stopping') -and !(Test-TrackedProcess $record $powershell)) {
        return [pscustomobject]@{ state = 'failed'; message = 'A previous runtime operation ended without a verified result. Partial installation is preserved; automatic retry and removal are blocked.'; processId = $record.processId; startedAt = $record.startedAt }
    }
    return $record
}

function New-Status([string]$state, [string]$message, [string[]]$blocked = @(), $fingerprint = $null, [bool]$keeperVerified = $false) {
    return [ordered]@{ state = $state; distribution = $distribution; installPath = $installPath; message = $message; blockedReasons = @($blocked); fingerprint = $fingerprint; operation = (Get-Operation); keeperVerified = $keeperVerified }
}

function Assert-OwnedRegistration($marker, $entries) {
    if (!$marker -or $marker.schema -ne 1 -or $marker.owner -cne 'DockSlate' -or $marker.distribution -cne $distribution -or $marker.rootfsSha256 -cne $rootfsHash -or $marker.engineVersion -cne $engineVersion -or $marker.state -cne 'installed') { throw 'The runtime ownership marker is missing, incomplete, or unsupported. Automatic reuse is blocked.' }
    if ([guid]::Parse([string]$marker.installId) -eq [guid]::Empty -or [guid]::Parse([string]$marker.registrationId) -eq [guid]::Empty) { throw 'The runtime ownership marker must contain nonempty installation and registration identities.' }
    if (!(Normalize-Path ([string]$marker.installPath)).Equals($installPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'The ownership marker does not identify the dynamically resolved DockSlate runtime directory.' }
    $matches = @($entries | Where-Object { $_.name -ieq $distribution })
    if ($matches.Count -ne 1 -or $matches[0].name -cne $distribution) { throw 'Exactly one case-matching DockSlate WSL registration is required.' }
    $registered = $matches[0]
    foreach ($entry in $entries) {
        if ($entry.id -ceq $registered.id) { continue }
        $otherPath = $null
        try { $otherPath = Normalize-Path $entry.basePath } catch { continue }
        if ($otherPath.Equals($installPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Another WSL registration shares the DockSlate runtime directory. Runtime access is blocked.' }
    }
    if ($registered.id -cne $marker.registrationId -or $registered.version -ne 2) { throw 'The WSL registration identity or version differs from the ownership marker.' }
    if (!(Normalize-Path $registered.basePath).Equals($installPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'The registered WSL BasePath does not match the owned runtime directory. Existing distributions will not be used.' }
    if ($registered.vhdFileName -cne 'ext4.vhdx') { throw 'The owned WSL registration has an unsupported disk filename.' }
    Assert-PlainPath $installPath
    $disk = Join-Path $installPath 'ext4.vhdx'
    Assert-PlainPath $disk
    if (!(Test-Path -LiteralPath $disk -PathType Leaf)) { throw 'The registered DockSlate runtime disk is absent.' }
    return [ordered]@{ installPath = $installPath; registrationId = $registered.id; installId = $marker.installId; engineVersion = $marker.engineVersion; rootfsSha256 = $marker.rootfsSha256 }
}

function Get-Inventory {
    if (!(Test-Path -LiteralPath $wsl -PathType Leaf)) { return New-Status 'unsupported' 'WSL 2 is unavailable. Install WSL using Windows before creating the DockSlate runtime.' @('The fixed Windows wsl.exe is unavailable.') }
    Assert-PlainPath $runtimeRoot
    $entries = @(Get-Registrations)
    $matches = @($entries | Where-Object { $_.name -ieq $distribution })
    $savedOperation = Get-Operation
    if ($savedOperation -and $savedOperation.state -in @('installing', 'starting', 'stopping')) { return New-Status $savedOperation.state $savedOperation.message }
    if (!(Test-Path -LiteralPath $runtimeRoot)) {
        if ($matches.Count -gt 0) { return New-Status 'unsupported' 'A WSL distribution named DockSlate already exists without DockSlate ownership. It will not be reused.' @('Distribution name collision.') }
        return New-Status 'not_installed' 'Create a separate DockSlate WSL 2 runtime to use Linux Docker Engine without Docker Desktop or Rancher Desktop.'
    }
    $marker = Read-OwnedJson 'ownership.json'
    if ($marker -and $marker.state -ceq 'installing') { return New-Status 'failed' 'The DockSlate runtime installation is incomplete. Its files and WSL registration are preserved for inspection.' @('Partial installation cannot be automatically retried or removed.') }
    try { $fingerprint = Assert-OwnedRegistration $marker $entries }
    catch { return New-Status 'unsupported' $_.Exception.Message @($_.Exception.Message) }
    $running = @(Get-Running)
    if ($running -notcontains $distribution) { return New-Status 'stopped' 'The verified DockSlate WSL runtime is installed and stopped.' @() $fingerprint }
    $keeper = Read-OwnedJson 'keeper.json'
    $verified = $keeper -and $keeper.installId -ceq $marker.installId -and (Test-TrackedProcess $keeper $wsl)
    $message = if ($verified) { 'The verified DockSlate WSL runtime is running. Docker Engine availability is checked through its owned Unix socket.' } else { 'The owned distribution is running without a verified DockSlate keepalive process. Stop it and start it through DockSlate before connecting.' }
    return New-Status 'running' $message @() $fingerprint ([bool]$verified)
}

function Get-InstallationPreview {
    $blocked = [Collections.Generic.List[string]]::new()
    $current = Get-Inventory
    if ($current.state -cne 'not_installed') { $blocked.Add($current.message) }
    if ([IO.File]::Exists($runtimeRoot) -or [IO.Directory]::Exists($runtimeRoot)) { $blocked.Add('The runtime target already exists; it will not be overwritten or automatically removed.') }
    foreach ($entry in @(Get-Registrations)) {
        $otherPath = $null
        try { $otherPath = Normalize-Path $entry.basePath } catch { continue }
        if ($otherPath.Equals($installPath, [StringComparison]::OrdinalIgnoreCase)) { $blocked.Add('A WSL registration already uses the runtime target directory. Existing registrations will not be changed.') }
    }
    $version = $null
    if (Test-Path -LiteralPath $wsl -PathType Leaf) {
        try {
            $text = Invoke-FixedWsl @('--version') $true
            if ($text -notmatch '(\d+\.\d+\.\d+)') { throw 'The installed WSL version cannot be parsed.' }
            $version = [version]$Matches[1]
            if ($version -lt [version]'2.4.10') { $blocked.Add('WSL 2.4.10 or later is required by the pinned Ubuntu WSL image.') }
            $null = Get-Running
        } catch { $blocked.Add($_.Exception.Message) }
    }
    $machine = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432')
    if (!$machine) { $machine = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE') }
    if ($machine -cne 'AMD64') { $blocked.Add('The pinned runtime payload supports x64 Windows only.') }
    $windows = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion', $false)
    if (!$windows) { $blocked.Add('Windows 11 cannot be verified.') }
    else {
        try { if ([int]$windows.GetValue('CurrentBuildNumber', '0') -lt 22000) { $blocked.Add('Windows 11 is required.') } }
        finally { $windows.Dispose() }
    }
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($installPath))
    if ($drive.DriveType -ne [IO.DriveType]::Fixed) { $blocked.Add('The runtime requires a fixed local drive.') }
    if ($drive.AvailableFreeSpace -lt 4GB) { $blocked.Add('At least 4 GiB of host free space is required before installation; Docker data will require additional space.') }
    return [ordered]@{
        eligible = $blocked.Count -eq 0
        targets = @(($distribution + ' (new WSL 2 distribution)'), $installPath, (Join-Path $runtimeRoot 'ownership.json'))
        impact = @('Download Ubuntu 24.04.5 x64 WSL rootfs and verify its pinned SHA-256 before import.', 'Install pinned Docker Engine and CLI 29.8.2, containerd 2.3.6, Buildx 0.38.0, Compose CLI 5.6.0, curl, iptables and nftables inside the new distribution using signed official APT repositories.', 'Create a separate ext4.vhdx and Docker data directory owned by DockSlate. No existing Docker data is imported.', 'Configure systemd and a root-only Unix socket; no Docker TCP listener is created.', 'Stop only the newly created DockSlate distribution after setup. It remains stopped until an approved Start action.')
        requirements = @('Windows 11 x64 with working WSL 2.4.10 or later.', 'HTTPS access to releases.ubuntu.com, official Ubuntu APT mirrors and download.docker.com.', 'A free DockSlate distribution name and an absent runtime target directory.', 'At least 4 GiB of host free space; container images and volumes use additional space.', 'Keep DockSlate open while setup runs. Failed imports and partial setup are preserved for inspection.')
        blockedReasons = @($blocked.ToArray())
        fingerprint = if ($blocked.Count -eq 0) { [ordered]@{ installPath = $installPath; runtimeRoot = $runtimeRoot; rootfsSha256 = $rootfsHash; engineVersion = $engineVersion; wslVersion = $version.ToString(); distribution = $distribution } } else { $null }
    }
}

function Assert-Expected($actual) {
    if (!$request.expected -or !$actual) { throw 'A verified approval fingerprint is required.' }
    if ($actual -is [Collections.IDictionary]) {
        foreach ($key in $actual.Keys) {
            if ([string]$request.expected.$key -cne [string]$actual[$key]) { throw 'Runtime safety conditions changed after approval. Create a new preview.' }
        }
    } else {
        foreach ($property in $actual.PSObject.Properties) {
            if ([string]$request.expected.($property.Name) -cne [string]$property.Value) { throw 'Runtime safety conditions changed after approval. Create a new preview.' }
        }
    }
}

function Set-Stage([string]$state, [string]$message) {
    $operation.state = $state
    $operation.message = $message
    $operation.updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Write-OwnedJson 'operation.json' $operation
}

function Begin-Operation([string]$state) {
    $script:operation = [ordered]@{ state = $state; message = 'Checking the owned runtime.'; processId = $PID; startedTicks = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks.ToString(); startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); childProcessId = $null; childStartedTicks = $null }
    $script:ownsOperation = $true
    Write-OwnedJson 'operation.json' $operation
}

function New-Keeper($marker) {
    $child = [DockSlateRuntimeLock]::StartKeeper($wsl)
    try {
        $keeper = [ordered]@{ processId = $child.Id; startedTicks = $child.StartTime.ToUniversalTime().Ticks.ToString(); installId = $marker.installId; distribution = $distribution }
        Write-OwnedJson 'keeper.json' $keeper
        return $keeper
    } finally { $child.Dispose() }
}

try {
    $runtimeRoot = Normalize-Path 'D:\Program Files\DockSlate\runtime'
    $installPath = Normalize-Path (Join-Path $runtimeRoot 'wsl')
    Assert-PlainPath $runtimeRoot
    switch -CaseSensitive ($request.mode) {
        'status' { $result = Get-Inventory }
        'preview' { $result = Get-InstallationPreview }
        'install' {
            if ($request.approved -ne $true) { throw 'Explicit installation approval is required.' }
            $preview = Get-InstallationPreview
            if (!$preview.eligible) { throw ($preview.blockedReasons -join ' ') }
            Assert-Expected $preview.fingerprint
            if (Test-Path -LiteralPath $runtimeRoot) { throw 'The runtime target appeared after approval. No files will be overwritten.' }
            $null = [IO.Directory]::CreateDirectory($runtimeRoot)
            Assert-PlainPath $runtimeRoot
            if (@(Get-ChildItem -LiteralPath $runtimeRoot -Force).Count -ne 0) { throw 'The runtime target contains unowned files. Installation is blocked.' }
            $marker = [ordered]@{ schema = 1; owner = 'DockSlate'; distribution = $distribution; installId = [guid]::NewGuid().ToString(); installPath = $installPath; registrationId = $null; rootfsSha256 = $rootfsHash; engineVersion = $engineVersion; state = 'installing' }
            $markerStream = [IO.File]::Open((Join-Path $runtimeRoot 'ownership.json'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($marker | ConvertTo-Json -Compress)); $markerStream.Write($bytes, 0, $bytes.Length) }
            finally { $markerStream.Dispose() }
            Lock-OwnedRuntime
            Begin-Operation 'installing'
            Set-Stage 'installing' 'Downloading and verifying the official Ubuntu 24.04.5 WSL rootfs.'
            $archive = Join-Path $runtimeRoot 'ubuntu-rootfs.tar'
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $rootfsUrl -OutFile $archive -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 900
            if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $rootfsHash) { throw 'The official rootfs SHA-256 does not match its pinned value. Import is blocked.' }
            if (@(Get-Registrations | Where-Object { $_.name -ieq $distribution }).Count -ne 0) { throw 'The distribution name became occupied before import. Existing registrations will not be changed.' }
            Assert-PlainPath $runtimeRoot
            Set-Stage 'installing' 'Importing only the new DockSlate WSL 2 distribution.'
            $null = Invoke-FixedWsl @('--import', $distribution, $installPath, $archive, '--version', '2')
            $registered = @(Get-Registrations | Where-Object { $_.name -ceq $distribution })
            if ($registered.Count -ne 1 -or $registered[0].version -ne 2 -or !(Normalize-Path $registered[0].basePath).Equals($installPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'The newly imported WSL registration does not match the owned target. Setup is blocked.' }
            $marker.registrationId = $registered[0].id
            Write-OwnedJson 'ownership.json' $marker
            Set-Stage 'installing' 'Installing verified Docker Engine packages and configuring the new owned distribution.'
            $setup = [Environment]::GetEnvironmentVariable('DOCKSLATE_RUNTIME_SETUP')
            if ([string]::IsNullOrWhiteSpace($setup)) { throw 'The fixed runtime setup script is unavailable.' }
            $null = Invoke-FixedWsl @('--distribution', $distribution, '--user', 'root', '--exec', '/bin/sh', '-s') $false $setup
            $registeredAfter = @(Get-Registrations | Where-Object { $_.name -ceq $distribution })
            if ($registeredAfter.Count -ne 1 -or $registeredAfter[0].id -cne $marker.registrationId -or !(Normalize-Path $registeredAfter[0].basePath).Equals($installPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'The owned registration changed during setup. No other distribution will be stopped.' }
            Set-Stage 'installing' 'Stopping only the newly created DockSlate distribution to activate its systemd configuration.'
            $null = Invoke-FixedWsl @('--terminate', $distribution)
            if (@(Get-Running) -contains $distribution) { throw 'The newly created DockSlate distribution did not stop. Installation completion is unverified.' }
            $marker.state = 'installed'
            Write-OwnedJson 'ownership.json' $marker
            Set-Stage 'completed' 'The separate DockSlate WSL runtime is installed and stopped. Start it with explicit approval.'
            $result = Get-Inventory
        }
        { $_ -cin @('start', 'stop') } {
            if ($request.approved -ne $true) { throw 'Explicit runtime state-change approval is required.' }
            $current = Get-Inventory
            $required = if ($request.mode -ceq 'start') { 'stopped' } else { 'running' }
            if ($current.state -cne $required) { throw $current.message }
            Assert-Expected $current.fingerprint
            Lock-OwnedRuntime
            $current = Get-Inventory
            if ($current.state -cne $required) { throw $current.message }
            Assert-Expected $current.fingerprint
            $marker = Read-OwnedJson 'ownership.json'
            $null = Assert-OwnedRegistration $marker @(Get-Registrations)
            if ($request.mode -ceq 'start') {
                Begin-Operation 'starting'
                Set-Stage 'starting' 'Starting the owned keepalive and Docker Engine inside DockSlate only.'
                $keeper = New-Keeper $marker
                $null = Invoke-FixedWsl @('--distribution', $distribution, '--user', 'root', '--exec', '/usr/local/libexec/dockslate-start')
                if (!(Test-TrackedProcess $keeper $wsl) -or @((Get-Running)) -notcontains $distribution) { throw 'The DockSlate keepalive exited or the owned distribution is not running. Start is unverified.' }
                Set-Stage 'completed' 'The owned DockSlate runtime is running and its Docker Unix socket answered the health check.'
            } else {
                Begin-Operation 'stopping'
                Set-Stage 'stopping' 'Stopping Docker services and running containers inside DockSlate only.'
                $null = Invoke-FixedWsl @('--distribution', $distribution, '--user', 'root', '--exec', '/usr/local/libexec/dockslate-stop')
                $null = Assert-OwnedRegistration (Read-OwnedJson 'ownership.json') @(Get-Registrations)
                Set-Stage 'stopping' 'Terminating only the verified DockSlate distribution. Other WSL distributions remain running.'
                $null = Invoke-FixedWsl @('--terminate', $distribution)
                if (@(Get-Running) -contains $distribution) { throw 'The owned DockSlate distribution did not stop. Stop is unverified.' }
                Set-Stage 'completed' 'The owned DockSlate runtime is stopped. Containers, images and volumes are preserved.'
            }
            $result = Get-Inventory
        }
        default { throw 'Unsupported fixed runtime operation.' }
    }
    $result | ConvertTo-Json -Depth 15 -Compress
} catch {
    $message = $_.Exception.Message
    if ($ownsOperation) { try { Set-Stage 'failed' $message } catch {} }
    [ordered]@{ state = 'failed'; distribution = $distribution; installPath = $installPath; message = $message; blockedReasons = @($message); operation = if ($ownsOperation) { $operation } else { $null } } | ConvertTo-Json -Depth 15 -Compress
    if ($request.mode -notin @('status', 'preview')) { exit 1 }
} finally {
    if ($mutationLock) { $mutationLock.Dispose() }
    if ($runtimeDirectoryHandle) { $runtimeDirectoryHandle.Dispose() }
}
