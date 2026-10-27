$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Environment]::GetEnvironmentVariable('DOCKSLATE_WSL_REQUEST') | ConvertFrom-Json
$registryPath = 'Software\Microsoft\Windows\CurrentVersion\Lxss'

function Get-Owner([string]$name) {
    switch -CaseSensitive ($name) {
        'rancher-desktop' { return 'Rancher Desktop' }
        'rancher-desktop-data' { return 'Rancher Desktop' }
        'docker-desktop' { return 'Docker Desktop' }
        'docker-desktop-data' { return 'Docker Desktop' }
        'DockSlate' { return 'DockSlate' }
        default { return $null }
    }
}

function Get-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        return ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } finally { $identity.Dispose() }
}

function Get-DiskTools {
    $checks = [Collections.Generic.List[object]]::new()
    $missing = [Collections.Generic.List[string]]::new()
    try {
        Initialize-FileIdentity
        [DockSlateVirtualDisk]::AssertSupported()
        $checks.Add([pscustomobject]@{ name = 'Windows Virtual Disk API'; available = $true; detail = 'Windows 내장 디스크 조회·압축 API' })
        return [pscustomobject]@{ available = $true; method = 'CompactVirtualDisk'; checks = @($checks.ToArray()); missing = @() }
    } catch {
        $checks.Add([pscustomobject]@{ name = 'Windows Virtual Disk API'; available = $false; detail = $_.Exception.Message })
    }
    foreach ($name in @('Storage\Get-DiskImage', 'Hyper-V\Get-VHD', 'Hyper-V\Optimize-VHD')) {
        try {
            $command = Get-Command $name -CommandType Cmdlet,Function -ErrorAction Stop
            if (!$command -or $command.Count -gt 1) { throw '명령을 하나로 확인할 수 없습니다.' }
            $checks.Add([pscustomobject]@{ name = $name; available = $true; detail = '사용 가능' })
        } catch {
            $missing.Add($name)
            $checks.Add([pscustomobject]@{ name = $name; available = $false; detail = 'Windows 관리 도구가 설치되어 있지 않거나 사용할 수 없습니다.' })
        }
    }
    return [pscustomobject]@{ available = ($missing.Count -eq 0); method = $(if ($missing.Count -eq 0) { 'Optimize-VHD' } else { $null }); checks = @($checks.ToArray()); missing = @($missing.ToArray()) }
}

function Get-LocalPath([string]$path, [bool]$allowExtended = $true) {
    if ([string]::IsNullOrWhiteSpace($path) -or $path.Length -gt 32760) { throw 'An absolute local file path is required.' }
    if ($allowExtended) {
        if ($path -notmatch '^(?:\\\\\?\\)?[A-Za-z]:\\') { throw 'Network, device, and relative paths are not supported.' }
    } elseif ($path -notmatch '^[A-Za-z]:\\') { throw 'The selected file must use an absolute local drive path. UNC and device paths are not supported.' }
    $full = [IO.Path]::GetFullPath($path)
    if ($full -notmatch '^(?:\\\\\?\\)?[A-Za-z]:\\') { throw 'Network, device, and relative paths are not supported.' }
    $drivePath = $full -replace '^\\\\\?\\', ''
    if ($drivePath.Substring(2).Contains(':')) { throw 'Alternate file streams are not supported.' }
    $drive = [IO.DriveInfo]::new($drivePath.Substring(0, 3))
    if ($drive.DriveType -ne [IO.DriveType]::Fixed -and $drive.DriveType -ne [IO.DriveType]::Removable) { throw 'The file must be on a verified local fixed or removable drive.' }
    return $full
}

function Assert-PlainPath([string]$path) {
    $cursor = $path
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points, links, and redirected ancestors are not supported.' }
        $parent = [IO.Path]::GetDirectoryName($cursor.TrimEnd('\'))
        if (!$parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Read-OwnershipJson($stream) {
    if ($stream.Length -le 0 -or $stream.Length -gt 65536) { throw 'Owned runtime metadata has an unsupported size.' }
    $stream.Position = 0
    $bytes = [byte[]]::new([int]$stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
        $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
        if ($count -eq 0) { throw 'Owned runtime metadata is incomplete.' }
        $offset += $count
    }
    $stream.Position = 0
    return ([Text.UTF8Encoding]::new($false, $true).GetString($bytes).TrimStart([char]0xFEFF) | ConvertFrom-Json -ErrorAction Stop)
}

function Close-OwnedRuntime($owner) {
    if (!$owner) { return }
    if ($owner.markerStream) { $owner.markerStream.Dispose() }
    if ($owner.operationStream) { $owner.operationStream.Dispose() }
    if ($owner.mutationStream) { $owner.mutationStream.Dispose() }
    foreach ($handle in $owner.metadataParents) { $handle.Dispose() }
}

function Get-OwnedRuntime($entry, [bool]$hold = $false, $heldOwner = $null) {
    $markerStream = $null
    $operationStream = $null
    $mutationStream = $null
    $metadataParents = [Collections.Generic.List[object]]::new()
    $retained = $false
    $borrowedMutation = $false
    try {
        if (!$entry -or $entry.distribution -cne 'DockSlate' -or $entry.version -ne 2 -or $entry.vhdFileName -cne 'ext4.vhdx') { throw 'The registration is not the fixed DockSlate WSL 2 distribution and disk.' }
        $runtimeRoot = Get-LocalPath 'D:\Program Files\DockSlate\runtime'
        $installPath = Get-LocalPath (Join-Path $runtimeRoot 'wsl')
        $registeredPath = (Get-LocalPath $entry.basePath) -replace '^\\\\\?\\', ''
        if (!$registeredPath.TrimEnd('\').Equals($installPath.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'The WSL BasePath does not match the dedicated DockSlate runtime directory.' }
        $expectedDisk = Get-LocalPath (Join-Path $installPath 'ext4.vhdx')
        if (!$entry.path -or !(($entry.path -replace '^\\\\\?\\', '').Equals($expectedDisk, [StringComparison]::OrdinalIgnoreCase))) { throw 'The registered disk is outside the verified DockSlate runtime directory.' }
        $registrationRoot = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPath, $false)
        if (!$registrationRoot) { throw 'DockSlate WSL registration uniqueness cannot be verified.' }
        try {
            foreach ($otherId in $registrationRoot.GetSubKeyNames()) {
                if ([guid]::Parse($otherId) -eq [guid]::Parse([string]$entry.id)) { continue }
                $other = $registrationRoot.OpenSubKey($otherId, $false)
                if (!$other) { throw 'Another WSL registration cannot be inspected for disk ownership.' }
                try {
                    $otherName = [string]$other.GetValue('DistributionName')
                    $otherBase = [Environment]::ExpandEnvironmentVariables([string]$other.GetValue('BasePath'))
                    if ($otherName -ieq 'DockSlate') { throw 'Another WSL registration uses the DockSlate name.' }
                    if ($otherBase) {
                        $otherPath = (Get-LocalPath $otherBase) -replace '^\\\\\?\\', ''
                        if ($otherPath.TrimEnd('\').Equals($installPath.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Another WSL distribution is registered against the DockSlate disk directory.' }
                    }
                } finally { $other.Dispose() }
            }
        } finally { $registrationRoot.Dispose() }
        Assert-PlainPath $installPath
        Initialize-FileIdentity
        $markerPath = Join-Path $runtimeRoot 'ownership.json'
        $operationPath = Join-Path $runtimeRoot 'operation.json'
        $mutationPath = Join-Path $runtimeRoot 'mutation.lock'
        foreach ($path in @($markerPath, $operationPath, $mutationPath)) {
            Assert-PlainPath $path
            foreach ($guard in [DockSlateFileIdentity]::GuardParents($path)) { $metadataParents.Add($guard) }
        }
        $mutationShare = if ($hold) { [IO.FileShare]::None } else { [IO.FileShare]::Read }
        if ($heldOwner) {
            if (!$heldOwner.mutationStream -or $heldOwner.path -cne $installPath -or [DockSlateFileIdentity]::Get($heldOwner.mutationStream) -cne $heldOwner.mutationIdentity) { throw 'The held DockSlate mutation lock does not match the verified installation.' }
            $mutationStream = $heldOwner.mutationStream
            $borrowedMutation = $true
        } else { $mutationStream = [DockSlateFileIdentity]::OpenRegular($mutationPath, $mutationShare) }
        $markerStream = [DockSlateFileIdentity]::OpenRegular($markerPath, [IO.FileShare]::Read)
        $operationStream = [DockSlateFileIdentity]::OpenRegular($operationPath, [IO.FileShare]::Read)
        $marker = Read-OwnershipJson $markerStream
        $operation = Read-OwnershipJson $operationStream
        if ($marker.schema -isnot [int] -or $marker.schema -ne 1 -or $marker.owner -cne 'DockSlate' -or $marker.distribution -cne 'DockSlate' -or $marker.state -cne 'installed') { throw 'DockSlate ownership metadata is missing, unsupported, or installation is incomplete.' }
        $installId = [guid]::Parse([string]$marker.installId)
        $registrationId = [guid]::Parse([string]$marker.registrationId)
        if ($installId -eq [guid]::Empty -or $registrationId -eq [guid]::Empty -or $registrationId -ne [guid]::Parse([string]$entry.id)) { throw 'DockSlate ownership IDs do not match the current WSL registration.' }
        $markedPath = (Get-LocalPath ([string]$marker.installPath)) -replace '^\\\\\?\\', ''
        if (!$markedPath.TrimEnd('\').Equals($installPath.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'DockSlate ownership metadata identifies a different installation directory.' }
        if ($marker.rootfsSha256 -cne 'bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e' -or $marker.engineVersion -cne '5:29.8.2-1~ubuntu.24.04~noble') { throw 'The owned runtime image or engine version does not match the verified DockSlate installation contract.' }
        if ($operation.state -cne 'completed') { throw 'The owned runtime operation is active, failed, or unverified. Compaction requires a completed operation and stopped WSL distribution.' }
        $owner = [pscustomobject]@{ owner = 'DockSlate'; path = $installPath; ownerId = $installId.ToString('D'); markerPath = $markerPath; markerIdentity = [DockSlateFileIdentity]::Get($markerStream); markerSha256 = Get-StreamHash $markerStream; operationIdentity = [DockSlateFileIdentity]::Get($operationStream); operationSha256 = Get-StreamHash $operationStream; mutationIdentity = [DockSlateFileIdentity]::Get($mutationStream); markerStream = $(if ($hold) { $markerStream } else { $null }); operationStream = $(if ($hold) { $operationStream } else { $null }); mutationStream = $(if ($hold) { $mutationStream } else { $null }); metadataParents = $(if ($hold) { @($metadataParents.ToArray()) } else { @() }) }
        $retained = $hold
        return $owner
    } finally {
        if (!$retained) {
            if ($markerStream) { $markerStream.Dispose() }
            if ($operationStream) { $operationStream.Dispose() }
            if ($mutationStream -and !$borrowedMutation) { $mutationStream.Dispose() }
            foreach ($handle in $metadataParents) { $handle.Dispose() }
        }
    }
}

function Get-Registrations($heldOwner = $null) {
    $entries = [Collections.Generic.List[object]]::new()
    $root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPath, $false)
    if (!$root) { return @() }
    try {
        foreach ($id in $root.GetSubKeyNames()) {
            $entry = $root.OpenSubKey($id, $false)
            if (!$entry) { throw 'A WSL registration cannot be read.' }
            try {
                $name = [string]$entry.GetValue('DistributionName')
                $owner = Get-Owner $name
                if (!$owner) { continue }
                $basePath = [Environment]::ExpandEnvironmentVariables([string]$entry.GetValue('BasePath'))
                $fileName = [string]$entry.GetValue('VhdFileName', 'ext4.vhdx')
                $version = $entry.GetValue('Version', 0)
                $path = $null
                $issues = [Collections.Generic.List[string]]::new()
                try {
                    $parsedId = [guid]::Parse($id)
                    if ([string]::IsNullOrWhiteSpace($basePath)) { throw 'The WSL registration has no BasePath.' }
                    if ([IO.Path]::GetFileName($fileName) -cne $fileName -or $fileName -notmatch '\.vhdx$') { throw 'The registered VhdFileName is not a plain VHDX filename.' }
                    $path = Get-LocalPath ([IO.Path]::Combine((Get-LocalPath $basePath), $fileName))
                    if ($version -ne 2) { $issues.Add('This distribution is not registered as WSL 2.') }
                } catch { $issues.Add($_.Exception.Message) }
                $registration = [pscustomobject]@{ id = $id; distribution = $name; owner = $owner; path = $path; version = $version; basePath = $basePath; vhdFileName = $fileName; issues = @() }
                if ($name -ceq 'DockSlate') {
                    try { $null = Get-OwnedRuntime $registration $false $heldOwner }
                    catch { $registration.owner = 'Unverified DockSlate registration'; $issues.Add('DockSlate ownership cannot be verified: ' + $_.Exception.Message) }
                }
                $registration.issues = @($issues.ToArray())
                $entries.Add($registration)
            } finally { $entry.Dispose() }
        }
    } finally { $root.Dispose() }
    return @($entries.ToArray())
}

function Invoke-WslList([bool]$running) {
    $program = Join-Path ([Environment]::GetFolderPath('System')) 'wsl.exe'
    if (!(Test-Path -LiteralPath $program -PathType Leaf)) { throw 'wsl.exe is unavailable. WSL state cannot be verified.' }
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $program
    $info.Arguments = if ($running) { '--list --running --quiet' } else { '--list --quiet' }
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::Unicode
    $info.StandardErrorEncoding = [Text.Encoding]::Unicode
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $info
    try {
        if (!$child.Start()) { throw 'The read-only WSL list command could not start.' }
        $outTask = $child.StandardOutput.ReadToEndAsync()
        $errTask = $child.StandardError.ReadToEndAsync()
        if (!$child.WaitForExit(15000)) {
            $child.Kill()
            throw 'The read-only WSL list command timed out. Distribution state is unknown.'
        }
        $stdout = $outTask.GetAwaiter().GetResult()
        $null = $errTask.GetAwaiter().GetResult()
        if ($child.ExitCode -ne 0) { throw "The read-only WSL list command failed (exit $($child.ExitCode)). Distribution state is unknown." }
        return @($stdout.Replace([string][char]0, '').Trim([char]0xFEFF) -split '[\r\n]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    } finally { $child.Dispose() }
}

function Get-RuntimeInstallations {
    $installations = [Collections.Generic.List[object]]::new()
    foreach ($hive in @([Microsoft.Win32.Registry]::CurrentUser, [Microsoft.Win32.Registry]::LocalMachine)) {
        foreach ($registryKey in @('Software\Microsoft\Windows\CurrentVersion\Uninstall', 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
            $root = $hive.OpenSubKey($registryKey, $false)
            if (!$root) { continue }
            try {
                foreach ($name in $root.GetSubKeyNames()) {
                    $item = $root.OpenSubKey($name, $false)
                    if (!$item) { throw 'Runtime installation metadata cannot be read.' }
                    try {
                        $owner = [string]$item.GetValue('DisplayName')
                        if ($owner -notin @('Rancher Desktop', 'Docker Desktop')) { continue }
                        $location = [string]$item.GetValue('InstallLocation')
                        $icon = [string]$item.GetValue('DisplayIcon')
                        $executable = $null
                        if ($location) {
                            $location = Get-LocalPath ([Environment]::ExpandEnvironmentVariables($location))
                            $executable = Join-Path $location ($owner + '.exe')
                        } elseif ($icon) {
                            if ($icon -match '^"([^"]+)"(?:,\s*-?\d+)?$' -or $icon -match '^([^,"]+)(?:,\s*-?\d+)?$') {
                                $executable = Get-LocalPath ([Environment]::ExpandEnvironmentVariables($Matches[1]))
                                if ([IO.Path]::GetFileName($executable) -ine ($owner + '.exe')) { throw 'Runtime DisplayIcon does not identify the expected executable.' }
                                $location = [IO.Path]::GetDirectoryName($executable)
                            } else { throw 'Runtime DisplayIcon cannot be resolved safely.' }
                        } else { throw ('Installation metadata has no verified runtime path: ' + $owner) }
                        if (!(Test-Path -LiteralPath $executable -PathType Leaf)) { throw ('The registered runtime executable is absent: ' + $owner) }
                        Assert-PlainPath $executable
                        $installations.Add([pscustomobject]@{ owner = $owner; path = $location; executable = $executable })
                    } finally { $item.Dispose() }
                }
            } finally { $root.Dispose() }
        }
    }
    return @($installations.ToArray() | Sort-Object owner, path -Unique)
}

function Get-RuntimeProcesses($installations = @(), [bool]$strict = $false) {
    $names = @('Rancher Desktop', 'RancherDesktop', 'rancher-desktop', 'host-switch', 'wsl-helper', 'rdctl', 'Docker Desktop', 'com.docker.backend', 'com.docker.service', 'com.docker.proxy', 'dockerd', 'vpnkit')
    $processes = @(Get-Process -ErrorAction Stop)
    $running = [Collections.Generic.List[string]]::new()
    foreach ($process in $processes) {
        if ($names -contains $process.ProcessName) {
            $running.Add("$($process.ProcessName) (PID $($process.Id))")
            continue
        }
        if ($installations.Count -eq 0) { continue }
        try { $path = $process.Path }
        catch { throw 'A process path cannot be inspected while verifying runtime ownership.' }
        if (!$path) {
            if ($strict -and $process.Id -notin @(0, 4)) { throw ('A process executable path is unknown; runtime exit cannot be verified: PID ' + $process.Id) }
            continue
        }
        foreach ($installation in $installations) {
            if ($path.StartsWith($installation.path.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
                $running.Add("$($process.ProcessName) (PID $($process.Id); registered runtime directory)")
                break
            }
        }
    }
    return @($running.ToArray())
}

function Get-DetachedState([string]$path, $diskTools = $null) {
    $file = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (($file.Attributes -band ([IO.FileAttributes]::SparseFile -bor [IO.FileAttributes]::Compressed -bor [IO.FileAttributes]::Encrypted)) -ne 0) { throw 'Sparse, compressed, or encrypted host files require a separately verified compaction method and are not supported.' }
    if (!$diskTools) { $diskTools = Get-DiskTools }
    if (!$diskTools.available) { throw 'Windows virtual disk inspection and compaction support is unavailable.' }
    if ($diskTools.method -ceq 'CompactVirtualDisk') { return [DockSlateVirtualDisk]::Inspect($path) }
    $null = Get-Command Storage\Get-DiskImage -ErrorAction Stop
    $null = Get-Command Hyper-V\Get-VHD -ErrorAction Stop
    $null = Get-Command Hyper-V\Optimize-VHD -ErrorAction Stop
    $diskImage = @(Storage\Get-DiskImage -ImagePath $path -ErrorAction Stop)
    $vhd = @(Hyper-V\Get-VHD -Path $path -ErrorAction Stop)
    if ($diskImage.Count -ne 1 -or $vhd.Count -ne 1) { throw 'Both Windows storage providers must identify exactly one disk image.' }
    if ($null -eq $diskImage[0].Attached -or $null -eq $vhd[0].Attached) { throw 'Disk attachment state is unknown.' }
    if ($diskImage[0].Attached -or $vhd[0].Attached) { throw 'The VHDX is attached. Detach it using the owning runtime before retrying.' }
    if ([string]$vhd[0].VhdFormat -ne 'VHDX' -or [string]$vhd[0].VhdType -ne 'Dynamic') { throw 'Only a detached, dynamically expanding VHDX is supported.' }
    if ($vhd[0].ParentPath) { throw 'Differencing disks and parent disk chains are not supported.' }
    $identifier = [guid]::Parse([string]$vhd[0].DiskIdentifier)
    if ($identifier -eq [guid]::Empty) { throw 'The virtual disk identifier is empty.' }
    return [pscustomobject]@{ Provider = 'Hyper-V PowerShell'; Identifier = $identifier.ToString('D'); Attached = $false; VhdFormat = 'VHDX'; VhdType = 'Dynamic' }
}

function Add-Check($checks, [string]$name, [string]$status, [string]$detail) {
    $checks.Add([pscustomobject]@{ name = $name; status = $status; detail = $detail })
}

function Initialize-FileIdentity {
    if ('DockSlateFileIdentity' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DockSlateFileIdentity {
    [StructLayout(LayoutKind.Sequential)] private struct StandardInfo {
        public long AllocationSize; public long EndOfFile; public uint Links;
        [MarshalAs(UnmanagedType.U1)] public bool DeletePending;
        [MarshalAs(UnmanagedType.U1)] public bool Directory;
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileInfo {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
        public System.Runtime.InteropServices.ComTypes.FILETIME Access; public System.Runtime.InteropServices.ComTypes.FILETIME Write;
        public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, out StandardInfo info, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint GetFileType(SafeFileHandle handle);
    private static FileInfo ReadInfo(SafeFileHandle handle) {
        FileInfo info;
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return info;
    }
    public static FileStream OpenRegular(string path, FileShare share) {
        var handle = CreateFile(path, 0x80000000, (uint)share, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
        try {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            var info = ReadInfo(handle);
            if (GetFileType(handle) != 1 || (info.Attributes & (0x10 | 0x400)) != 0) throw new IOException("Only an ordinary local file without links is permitted.");
            if (info.Links != 1) throw new IOException("Files with multiple hard links are not supported.");
            return new FileStream(handle, FileAccess.Read);
        } catch { handle.Dispose(); throw; }
    }
    public static SafeFileHandle[] GuardParents(string path) {
        var guards = new List<SafeFileHandle>();
        string parent = Path.GetDirectoryName(path);
        try {
            while (!String.IsNullOrEmpty(parent)) {
                var handle = CreateFile(parent, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
                guards.Add(handle);
                var info = ReadInfo(handle);
                if ((info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0) throw new IOException("An ancestor is redirected or is not a directory.");
                string next = Path.GetDirectoryName(parent.TrimEnd('\\'));
                if (next == parent) break;
                parent = next;
            }
            return guards.ToArray();
        } catch { foreach (var guard in guards) guard.Dispose(); throw; }
    }
    public static string Get(FileStream stream) {
        FileInfo info = ReadInfo(stream.SafeFileHandle);
        return info.Volume.ToString("x8") + ":" + info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8");
    }
    public static long Allocation(FileStream stream) {
        StandardInfo info;
        if (!GetFileInformationByHandleEx(stream.SafeFileHandle, 1, out info, (uint)Marshal.SizeOf(typeof(StandardInfo)))) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (info.Directory || info.DeletePending || info.AllocationSize < 0) throw new IOException("The file allocation cannot be verified.");
        return info.AllocationSize;
    }
}
public static class DockSlateVirtualDisk {
    [StructLayout(LayoutKind.Sequential)] private struct StorageType {
        public uint DeviceId; public Guid VendorId;
    }
    [StructLayout(LayoutKind.Sequential)] private struct OpenParameters {
        public uint Version; public uint RWDepth;
    }
    [StructLayout(LayoutKind.Sequential)] private struct CompactParameters {
        public uint Version; public uint Reserved;
    }
    [StructLayout(LayoutKind.Explicit, Size=32)] private struct DiskInfo {
        [FieldOffset(0)] public uint Version;
        [FieldOffset(8)] public uint Value;
        [FieldOffset(8)] public Guid Identifier;
        [FieldOffset(12)] public Guid VendorId;
    }
    public sealed class Inspection {
        public string Provider = "Windows Virtual Disk API";
        public string Identifier;
        public bool Attached = false;
        public string VhdFormat = "VHDX";
        public string VhdType = "Dynamic";
    }
    private static readonly Guid MicrosoftVendor = new Guid("ec984aec-a0f9-47e9-901f-71415a66345b");
    private const uint GetInfo = 0x00080000;
    private const uint MetaOps = 0x00200000;
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Ansi, ExactSpelling=true, SetLastError=true)] private static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool FreeLibrary(IntPtr module);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("virtdisk.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] private static extern uint OpenVirtualDisk(ref StorageType storageType, string path, uint access, uint flags, ref OpenParameters parameters, out SafeFileHandle handle);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("virtdisk.dll", ExactSpelling=true)] private static extern uint GetVirtualDiskInformation(SafeFileHandle handle, ref uint size, ref DiskInfo info, out uint used);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("virtdisk.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] private static extern uint GetVirtualDiskPhysicalPath(SafeFileHandle handle, ref uint bytes, System.Text.StringBuilder path);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("virtdisk.dll", ExactSpelling=true)] private static extern uint CompactVirtualDisk(SafeFileHandle handle, uint flags, ref CompactParameters parameters, IntPtr overlapped);
    private static void Check(uint status, string operation) {
        if (status != 0) throw new Win32Exception((int)status, operation + " failed (" + status.ToString() + "): " + new Win32Exception((int)status).Message);
    }
    public static void AssertSupported() {
        string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "virtdisk.dll");
        IntPtr module = LoadLibraryEx(path, IntPtr.Zero, 0x00000800);
        if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows Virtual Disk API cannot be loaded.");
        try {
            foreach (string name in new string[] { "OpenVirtualDisk", "GetVirtualDiskInformation", "GetVirtualDiskPhysicalPath", "CompactVirtualDisk" }) {
                if (GetProcAddress(module, name) == IntPtr.Zero) throw new NotSupportedException("Windows Virtual Disk API is unavailable: " + name);
            }
        } finally { FreeLibrary(module); }
    }
    private static SafeFileHandle Open(string path, bool writable) {
        var storageType = new StorageType { DeviceId = 3, VendorId = MicrosoftVendor };
        var parameters = new OpenParameters { Version = 1, RWDepth = writable ? 1u : 0u };
        SafeFileHandle handle;
        uint status = OpenVirtualDisk(ref storageType, path, GetInfo | (writable ? MetaOps : 0), 1, ref parameters, out handle);
        if (status != 0) {
            if (handle != null) handle.Dispose();
            Check(status, "OpenVirtualDisk");
        }
        if (handle == null || handle.IsInvalid) { if (handle != null) handle.Dispose(); throw new IOException("Windows returned no virtual disk handle."); }
        return handle;
    }
    private static DiskInfo Query(SafeFileHandle handle, uint version) {
        var info = new DiskInfo { Version = version };
        uint size = (uint)Marshal.SizeOf(typeof(DiskInfo));
        uint used;
        Check(GetVirtualDiskInformation(handle, ref size, ref info, out used), "GetVirtualDiskInformation");
        uint required = version == 6 ? 28u : (version == 2 ? 24u : 12u);
        if (info.Version != version || size > Marshal.SizeOf(typeof(DiskInfo)) || used < required || used > size) throw new IOException("Windows returned an unsupported virtual disk information layout.");
        return info;
    }
    private static Inspection InspectHandle(SafeFileHandle handle) {
        var storageType = Query(handle, 6);
        if (storageType.Value != 3 || storageType.VendorId != MicrosoftVendor) throw new IOException("Only a Microsoft VHDX is supported.");
        if (Query(handle, 7).Value != 3) throw new IOException("Only a dynamic VHDX without a parent disk is supported.");
        uint loaded = Query(handle, 13).Value;
        if (loaded != 0) throw new IOException("The VHDX is attached or its attachment state is unknown. Keep the owning engine stopped and retry.");
        var physicalPath = new System.Text.StringBuilder(512);
        uint bytes = 1024;
        uint status = GetVirtualDiskPhysicalPath(handle, ref bytes, physicalPath);
        if (status == 0) throw new IOException("The VHDX is attached to a Windows physical disk device.");
        if (status != 55) Check(status, "GetVirtualDiskPhysicalPath");
        Guid identifier = Query(handle, 2).Identifier;
        if (identifier == Guid.Empty) throw new IOException("The virtual disk identifier is empty.");
        return new Inspection { Identifier = identifier.ToString("D") };
    }
    public static Inspection Inspect(string path) {
        using (var handle = Open(path, false)) { return InspectHandle(handle); }
    }
    public static void Compact(string path, string expectedIdentifier) {
        using (var handle = Open(path, true)) {
            var disk = InspectHandle(handle);
            if (!String.Equals(disk.Identifier, expectedIdentifier, StringComparison.Ordinal)) throw new IOException("The approved virtual disk identifier changed.");
            var parameters = new CompactParameters { Version = 1, Reserved = 0 };
            Check(CompactVirtualDisk(handle, 0, ref parameters, IntPtr.Zero), "CompactVirtualDisk");
            if (!String.Equals(InspectHandle(handle).Identifier, expectedIdentifier, StringComparison.Ordinal)) throw new IOException("The virtual disk state changed during compaction.");
        }
    }
}
'@ -ErrorAction Stop
}

function Get-StreamHash($stream) {
    $stream.Position = 0
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Position = 0 }
}

function Get-Inventory {
    $diagnostics = [Collections.Generic.List[string]]::new()
    $admin = Get-Admin
    $diskTools = Get-DiskTools
    $running = @()
    $runningKnown = $false
    try { $running = @(Invoke-WslList $true); $runningKnown = $true }
    catch { $diagnostics.Add($_.Exception.Message) }
    $runtime = @()
    $runtimeKnown = $false
    $installations = @()
    try { $installations = @(Get-RuntimeInstallations); $runtime = @(Get-RuntimeProcesses $installations); $runtimeKnown = $true }
    catch { $diagnostics.Add('Runtime ownership or process enumeration cannot be verified: ' + $_.Exception.Message) }
    $registrations = @(Get-Registrations)
    $disks = [Collections.Generic.List[object]]::new()
    foreach ($entry in $registrations) {
        $reasons = [Collections.Generic.List[string]]::new()
        foreach ($issue in $entry.issues) { $reasons.Add($issue) }
        $exists = $false
        $size = $null
        if ($entry.path) {
            try {
                $item = Get-Item -LiteralPath $entry.path -Force -ErrorAction Stop
                if ($item.PSIsContainer) { throw 'The registered VHDX path points to a directory.' }
                $exists = $true
                $size = [long]$item.Length
                Assert-PlainPath $entry.path
            } catch { $reasons.Add('The registered VHDX cannot be read safely: ' + $_.Exception.Message) }
        }
        $isRunning = $null
        if ($runningKnown) { $isRunning = $running -contains $entry.distribution }
        else { $reasons.Add('WSL running state is unknown.') }
        if ($running.Count -gt 0) { $reasons.Add('Running WSL distributions must be stopped manually: ' + ($running -join ', ')) }
        if (!$runtimeKnown) { $reasons.Add('Runtime process state is unknown.') }
        elseif ($runtime.Count -gt 0) { $reasons.Add('Container runtime processes must be exited manually: ' + ($runtime -join ', ')) }
        if (!$admin) { $reasons.Add('An elevated Windows administrator session is required for compaction.') }
        $attached = $null
        if ($exists -and ($admin -or $diskTools.method -ceq 'CompactVirtualDisk')) {
            try { $null = Get-DetachedState $entry.path $diskTools; $attached = $false }
            catch { $reasons.Add('Disk separation cannot be verified: ' + $_.Exception.Message) }
        } else { $reasons.Add('Disk separation has not been verified by the Windows Virtual Disk API.') }
        $disks.Add([pscustomobject]@{ id = $entry.id; distribution = $entry.distribution; owner = $entry.owner; path = $entry.path; exists = $exists; fileSizeBytes = $size; running = $isRunning; attached = $attached; compactionStatus = 'blocked'; blockedReasons = @($reasons.ToArray()) })
    }
    if ($registrations.Count -eq 0) { $diagnostics.Add('No DockSlate, Rancher Desktop, or Docker Desktop WSL disk registration was found. Unregistered disks are not guessed or scanned.') }
    return [pscustomobject]@{ status = $(if ($diagnostics.Count -gt 0 -and $disks.Count -gt 0) { 'partial' } elseif ($disks.Count -eq 0) { 'empty' } else { 'ready' }); disks = @($disks.ToArray()); runningDistributions = @($running); runtimeProcesses = @($runtime); admin = $admin; diagnostics = @($diagnostics.ToArray()) }
}

function Get-Preflight {
    $checks = [Collections.Generic.List[object]]::new()
    $reasons = [Collections.Generic.List[string]]::new()
    $source = $null
    $entry = $null
    $fingerprint = $null
    $sourceParents = @()
    $installations = @()
    $runtimeOwner = $null
    $diskState = $null
    $diskTools = Get-DiskTools
    try {
        $entries = @(Get-Registrations)
        $matches = @($entries | Where-Object { $_.id -ceq [string]$request.diskId })
        if ($matches.Count -ne 1) { throw 'The requested disk ID does not identify a current supported WSL registration.' }
        $entry = $matches[0]
        if ($entry.issues.Count -gt 0) { throw ($entry.issues -join ' ') }
        if (@($entries | Where-Object { $_.distribution -ceq $entry.distribution -or $_.path -ieq $entry.path }).Count -ne 1) { throw 'Duplicate distribution or disk registrations prevent unambiguous ownership.' }
        Assert-PlainPath $entry.path
        Add-Check $checks 'ownership' 'passed' ('WSL 2 registration: ' + $entry.distribution + '; owner: ' + $entry.owner)
    } catch { $reasons.Add($_.Exception.Message); Add-Check $checks 'ownership' 'blocked' $_.Exception.Message }
    try {
        if (!$entry -or $checks[0].status -ne 'passed') { throw 'The runtime owner requires a verified disk registration.' }
        $installations = @(Get-RuntimeInstallations)
        if ($entry.owner -ceq 'DockSlate') {
            $runtimeOwner = Get-OwnedRuntime $entry $true
            Add-Check $checks 'runtimeOwner' 'passed' 'DockSlate ownership marker, installation ID, completed operation, WSL registration ID, and dedicated BasePath were verified. Metadata and the existing runtime mutation lock remain read-locked.'
        } else {
            $owners = @($installations | Where-Object { $_.owner -ceq $entry.owner })
            if ($owners.Count -ne 1) { throw 'The owning runtime installation cannot be identified unambiguously in Windows uninstall registrations.' }
            $runtimeOwner = $owners[0]
            Add-Check $checks 'runtimeOwner' 'passed' ('The owning runtime executable and installation directory were verified from Windows registration: ' + $runtimeOwner.owner)
        }
    } catch { $reasons.Add($_.Exception.Message); Add-Check $checks 'runtimeOwner' 'blocked' $_.Exception.Message }
    if ($diskTools.available) { Add-Check $checks 'diskTools' 'passed' ('Windows 디스크 조회·압축을 사용할 수 있습니다: ' + $diskTools.method) }
    else {
        $detail = 'Required Windows disk tools are unavailable: ' + ($diskTools.missing -join ', ')
        $reasons.Add($detail)
        Add-Check $checks 'diskTools' 'blocked' $detail
    }
    $admin = Get-Admin
    if ($admin) { Add-Check $checks 'administrator' 'passed' 'The Windows process token is elevated.' }
    else { $reasons.Add('An elevated Windows administrator session is required.'); Add-Check $checks 'administrator' 'blocked' 'The Windows process token is not elevated.' }
    try {
        $listed = @(Invoke-WslList $false)
        $running = @(Invoke-WslList $true)
        if ($entry -and $listed -cnotcontains $entry.distribution) { throw 'The registry distribution is absent from the authoritative WSL list.' }
        if ($running.Count -gt 0) { throw ('Running WSL distributions must be stopped manually: ' + ($running -join ', ')) }
        Add-Check $checks 'wslStopped' 'passed' 'WSL reports no running distribution. No shutdown command is issued.'
    } catch { $reasons.Add($_.Exception.Message); Add-Check $checks 'wslStopped' 'blocked' $_.Exception.Message }
    try {
        $processes = @(Get-RuntimeProcesses $installations $true)
        if ($processes.Count -gt 0) { throw ('Container runtime processes must be exited manually: ' + ($processes -join ', ')) }
        Add-Check $checks 'runtimeExited' 'passed' 'No supported desktop runtime or helper process is running. DockSlate Linux engine and keeper require the owned WSL distribution to remain stopped; the management UI may stay open.'
    } catch { $reasons.Add($_.Exception.Message); Add-Check $checks 'runtimeExited' 'blocked' $_.Exception.Message }
    try {
        if (!$entry -or $checks[0].status -ne 'passed') { throw 'Disk inspection requires verified ownership.' }
        if (!$admin -and $diskTools.method -cne 'CompactVirtualDisk') { throw 'Disk inspection requires an elevated Windows administrator session.' }
        $diskState = Get-DetachedState $entry.path $diskTools
        Add-Check $checks 'detachedDynamicVhdx' 'passed' ($diskState.Provider + ': detached dynamic VHDX without a parent; disk ID ' + $diskState.Identifier)
    } catch { $reasons.Add($_.Exception.Message); Add-Check $checks 'detachedDynamicVhdx' 'blocked' $_.Exception.Message }
    try {
        if (!$entry -or $checks[0].status -ne 'passed') { throw 'The original disk registration is not verified.' }
        Initialize-FileIdentity
        $sourceParents = @([DockSlateFileIdentity]::GuardParents($entry.path))
        $source = [DockSlateFileIdentity]::OpenRegular($entry.path, [IO.FileShare]::None)
        Add-Check $checks 'exclusiveLock' 'passed' 'An exclusive read handle acquired the registered VHDX without creating or modifying it.'
    } catch { $reasons.Add('Exclusive VHDX lock failed: ' + $_.Exception.Message); Add-Check $checks 'exclusiveLock' 'blocked' $_.Exception.Message }
    try {
        if (!$source -or !$entry -or !$runtimeOwner) { throw 'Disk identity inspection requires the verified owner and an exclusive file handle.' }
        if ($source.Length -le 0) { throw 'The original disk is empty.' }
        $sourceId = [DockSlateFileIdentity]::Get($source)
        if ($reasons.Count -eq 0) {
            $fingerprint = [pscustomobject]@{ diskId = $entry.id; distribution = $entry.distribution; owner = $entry.owner; runtimePath = $runtimeOwner.path; path = $entry.path; sourceIdentity = $sourceId; fileSizeBytes = [long]$source.Length; sourceLastWriteUtc = [IO.File]::GetLastWriteTimeUtc($entry.path).Ticks.ToString(); registryBasePath = $entry.basePath; registryVhdFileName = $entry.vhdFileName; backupPolicy = 'none'; compactionMethod = $diskTools.method; virtualDiskId = $diskState.Identifier }
            if ($entry.owner -ceq 'DockSlate') {
                foreach ($field in @('ownerId', 'markerPath', 'markerIdentity', 'markerSha256', 'operationIdentity', 'operationSha256', 'mutationIdentity')) { $fingerprint | Add-Member -NotePropertyName $field -NotePropertyValue $runtimeOwner.($field) }
            }
        }
        Add-Check $checks 'sourceIdentity' 'passed' 'The exclusively locked original disk identity, length and last-write timestamp bind this approval to the registered VHDX.'
    } catch { $reasons.Add('Disk identity verification failed: ' + $_.Exception.Message); Add-Check $checks 'sourceIdentity' 'blocked' $_.Exception.Message }
    return [pscustomobject]@{ diskId = [string]$request.diskId; path = $(if ($entry) { $entry.path } else { $null }); distribution = $(if ($entry) { $entry.distribution } else { $null }); owner = $(if ($entry) { $entry.owner } else { $null }); eligible = ($reasons.Count -eq 0); requiresBackup = $false; method = $diskTools.method; diskTools = $diskTools; blockedReasons = @($reasons.ToArray()); checks = @($checks.ToArray()); warnings = @('백업 없이 원본 VHDX를 변경합니다. 실패하면 DockSlate에서 데이터를 복구할 수 없습니다.', '엔진 종료와 디스크 분리는 자동으로 수행하지 않습니다.', 'Windows 내장 압축으로 0이 채워진 빈 블록을 회수합니다. 파일 크기가 줄어들지 않을 수 있습니다.', '실행 직전에 모든 안전 조건을 다시 확인합니다.'); fileSizeBytes = $(if ($source) { [long]$source.Length } else { $null }); fingerprint = $fingerprint; sourceStream = $source; sourceParents = $sourceParents; ownedRuntime = $(if ($entry -and $entry.owner -ceq 'DockSlate') { $runtimeOwner } else { $null }) }
}

function Close-Preflight($preflight) {
    if ($preflight.sourceStream) { $preflight.sourceStream.Dispose() }
    foreach ($handle in $preflight.sourceParents) { $handle.Dispose() }
    Close-OwnedRuntime $preflight.ownedRuntime
}

function Get-PublicPreflight($preflight) {
    return $preflight | Select-Object diskId, path, distribution, owner, eligible, requiresBackup, method, diskTools, blockedReasons, checks, warnings, fileSizeBytes, fingerprint
}

function Get-ShutdownPreview {
    $preflight = Get-Preflight
    try {
        if ($preflight.owner -cne 'DockSlate' -or !$preflight.ownedRuntime) { throw 'WSL shutdown recovery requires the verified DockSlate disk.' }
        foreach ($name in @('ownership', 'runtimeOwner', 'wslStopped', 'runtimeExited')) {
            $check = @($preflight.checks | Where-Object { $_.name -ceq $name -and $_.status -ceq 'passed' })
            if ($check.Count -ne 1) { throw ('Complete the prerequisite before WSL shutdown: ' + $name) }
        }
        $distributions = @(Invoke-WslList $false | Sort-Object)
        if ($distributions -cnotcontains $preflight.distribution -or @(Invoke-WslList $true).Count -gt 0) { throw 'Stop all WSL distributions before approving virtual machine shutdown.' }
        $fingerprint = [pscustomobject]@{ action = 'shutdown'; diskId = $preflight.diskId; path = $preflight.path; distributions = ($distributions -join "`n"); ownerId = $preflight.ownedRuntime.ownerId; markerSha256 = $preflight.ownedRuntime.markerSha256; operationSha256 = $preflight.ownedRuntime.operationSha256 }
        return [pscustomobject]@{ eligible = $true; diskId = $preflight.diskId; path = $preflight.path; distributions = $distributions; fingerprint = $fingerprint }
    } finally { Close-Preflight $preflight }
}

function Invoke-Shutdown {
    if ($request.approved -ne $true -or !$request.expected -or $request.expected.action -cne 'shutdown') { throw 'A separate WSL shutdown preview and explicit approval are required.' }
    $preview = Get-ShutdownPreview
    foreach ($property in $preview.fingerprint.PSObject.Properties) {
        if ([string]$request.expected.($property.Name) -cne [string]$property.Value) { throw ('The WSL shutdown preview changed: ' + $property.Name + '. Create a new preview.') }
    }
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = Join-Path ([Environment]::GetFolderPath('System')) 'wsl.exe'
    $info.Arguments = '--shutdown'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $info
    try {
        if (!$child.Start()) { throw 'WSL virtual machine shutdown could not start.' }
        $outTask = $child.StandardOutput.ReadToEndAsync()
        $errTask = $child.StandardError.ReadToEndAsync()
        if (!$child.WaitForExit(30000)) { $child.Kill(); throw 'WSL shutdown timed out. Disk separation remains unverified.' }
        $null = $outTask.GetAwaiter().GetResult()
        $null = $errTask.GetAwaiter().GetResult()
        if ($child.ExitCode -ne 0 -or @(Invoke-WslList $true).Count -gt 0) { throw 'WSL virtual machine shutdown could not be verified. Inspect the disk before retrying.' }
    } finally { $child.Dispose() }
    return [pscustomobject]@{ status = 'completed'; diskId = $preview.diskId; path = $preview.path }
}

function Invoke-Compaction {
    if ($request.approved -ne $true -or !$request.expected) { throw 'A backend preview and explicit approval are required.' }
    $preflight = Get-Preflight
    $guard = $null
    try {
        if (!$preflight.eligible) { throw ('Compaction is blocked: ' + ($preflight.blockedReasons -join ' ')) }
        foreach ($property in $preflight.fingerprint.PSObject.Properties) {
            if ([string]$request.expected.($property.Name) -cne [string]$property.Value) { throw ('The approved preview is stale. Changed field: ' + $property.Name + '. Create a new preview.') }
        }
        $before = [long]$preflight.sourceStream.Length
        $allocatedBefore = [DockSlateFileIdentity]::Allocation($preflight.sourceStream)
        Assert-PlainPath $preflight.path
        $entries = @(Get-Registrations $preflight.ownedRuntime | Where-Object { $_.id -ceq $preflight.diskId -and $_.path -ceq $preflight.path -and $_.distribution -ceq $preflight.distribution -and $_.issues.Count -eq 0 })
        if ($entries.Count -ne 1) { throw 'Disk registration changed before compaction.' }
        $installations = @(Get-RuntimeInstallations)
        if ($preflight.owner -ceq 'DockSlate') {
            $ownedRuntime = Get-OwnedRuntime $entries[0] $false $preflight.ownedRuntime
            foreach ($field in @('path', 'ownerId', 'markerPath', 'markerIdentity', 'markerSha256', 'operationIdentity', 'operationSha256', 'mutationIdentity')) {
                $expectedField = if ($field -ceq 'path') { 'runtimePath' } else { $field }
                if ([string]$ownedRuntime.($field) -cne [string]$preflight.fingerprint.($expectedField)) { throw 'DockSlate ownership metadata changed before compaction.' }
            }
        } elseif (@($installations | Where-Object { $_.owner -ceq $preflight.owner -and $_.path -ceq $preflight.fingerprint.runtimePath }).Count -ne 1) { throw 'The registered owning runtime changed before compaction.' }
        $listed = @(Invoke-WslList $false)
        if ($listed -cnotcontains $preflight.distribution) { throw 'The disk owner is absent from the WSL list.' }
        if (@(Invoke-WslList $true).Count -gt 0) { throw 'A WSL distribution started after the preview. Compaction is blocked.' }
        if (@(Get-RuntimeProcesses $installations $true).Count -gt 0) { throw 'A container runtime started after the preview. Compaction is blocked.' }
        if (!(Get-Admin)) { throw 'The elevated administrator token is no longer available.' }
        $preflight.sourceStream.Dispose()
        $preflight.sourceStream = $null
        $guard = [DockSlateFileIdentity]::OpenRegular($preflight.path, [IO.FileShare]::ReadWrite)
        if ([DockSlateFileIdentity]::Get($guard) -cne $preflight.fingerprint.sourceIdentity -or $guard.Length -ne $before -or [IO.File]::GetLastWriteTimeUtc($preflight.path).Ticks.ToString() -cne $preflight.fingerprint.sourceLastWriteUtc) { throw 'The disk changed while handing the lock to the Windows virtual disk service.' }
        $diskState = Get-DetachedState $preflight.path $preflight.diskTools
        if ($diskState.Identifier -cne $preflight.fingerprint.virtualDiskId) { throw 'The virtual disk identifier changed before compaction.' }
        if ($preflight.fingerprint.compactionMethod -ceq 'CompactVirtualDisk') {
            [DockSlateVirtualDisk]::Compact($preflight.path, $preflight.fingerprint.virtualDiskId)
        } elseif ($preflight.fingerprint.compactionMethod -ceq 'Optimize-VHD') {
            Hyper-V\Optimize-VHD -Path $preflight.path -Mode Full -ErrorAction Stop -Confirm:$false
        } else { throw 'The approved Windows compaction method is unsupported.' }
        if ([DockSlateFileIdentity]::Get($guard) -cne $preflight.fingerprint.sourceIdentity) { throw 'Disk file identity changed during optimization. The result cannot be verified.' }
        $after = [long]$guard.Length
        $allocatedAfter = [DockSlateFileIdentity]::Allocation($guard)
        return [pscustomobject]@{ status = 'completed'; diskId = $preflight.diskId; path = $preflight.path; beforeBytes = $before; afterBytes = $after; vhdxReductionBytes = ($before - $after); allocatedBeforeBytes = $allocatedBefore; allocatedAfterBytes = $allocatedAfter; reclaimedBytes = ($allocatedBefore - $allocatedAfter); method = $preflight.method; warnings = @($preflight.warnings) + @('회수량은 이 파일의 Windows 할당 크기 감소량입니다. 다른 앱의 여유 공간 변화나 SSD 물리 블록 회수량과는 다릅니다.'); backupCreated = $false }
    } finally {
        if ($guard) { $guard.Dispose() }
        Close-Preflight $preflight
    }
}

try {
    switch ([string]$request.mode) {
        'inventory' { $result = Get-Inventory }
        'preview' {
            $preflight = Get-Preflight
            try { $result = Get-PublicPreflight $preflight }
            finally { Close-Preflight $preflight }
        }
        'compact' { $result = Invoke-Compaction }
        'shutdown_preview' { $result = Get-ShutdownPreview }
        'shutdown' { $result = Invoke-Shutdown }
        default { throw 'Unsupported disk command.' }
    }
    $result | ConvertTo-Json -Depth 12 -Compress
} catch {
    [pscustomobject]@{ status = 'failed'; error = $_.Exception.Message } | ConvertTo-Json -Depth 4 -Compress
    exit 1
}
