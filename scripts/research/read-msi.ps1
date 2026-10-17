param(
  [Parameter(Mandatory = $true)][string]$MsiPath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$MsiPath = (Resolve-Path -LiteralPath $MsiPath).Path
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output directory must be new' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null

# Read-only MSI database access
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public sealed class ReadOnlyMsi : IDisposable {
  private uint database;
  [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiOpenDatabaseW(string path, IntPtr persist, out uint database);
  [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiDatabaseOpenViewW(uint database, string query, out uint view);
  [DllImport("msi.dll")] static extern uint MsiViewExecute(uint view, uint record);
  [DllImport("msi.dll")] static extern uint MsiViewFetch(uint view, out uint record);
  [DllImport("msi.dll")] static extern uint MsiRecordGetFieldCount(uint record);
  [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiRecordGetStringW(uint record, uint field, StringBuilder value, ref uint length);
  [DllImport("msi.dll")] static extern uint MsiRecordReadStream(uint record, uint field, byte[] data, ref uint length);
  [DllImport("msi.dll")] static extern uint MsiCloseHandle(uint handle);
  static void Check(uint result) { if (result != 0) throw new InvalidOperationException("MSI error " + result); }
  public ReadOnlyMsi(string path) { Check(MsiOpenDatabaseW(path, IntPtr.Zero, out database)); }
  public List<string[]> Query(string query) {
    uint view; Check(MsiDatabaseOpenViewW(database, query, out view));
    try {
      Check(MsiViewExecute(view, 0));
      var rows = new List<string[]>();
      uint record, result;
      while ((result = MsiViewFetch(view, out record)) == 0) {
        try {
          var row = new string[MsiRecordGetFieldCount(record)];
          for (uint field = 1; field <= row.Length; field++) {
            uint size = 32767; var text = new StringBuilder((int)size + 1);
            Check(MsiRecordGetStringW(record, field, text, ref size)); row[field - 1] = text.ToString();
          }
          rows.Add(row);
        } finally { MsiCloseHandle(record); }
      }
      if (result != 259) Check(result);
      return rows;
    } finally { MsiCloseHandle(view); }
  }
  public void CopyStream(string name, string destination) {
    uint view; Check(MsiDatabaseOpenViewW(database, "SELECT `Data` FROM `_Streams` WHERE `Name` = '" + name.Replace("'", "''") + "'", out view));
    try {
      Check(MsiViewExecute(view, 0)); uint record; Check(MsiViewFetch(view, out record));
      try {
        using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write)) {
          var data = new byte[1048576];
          while (true) { uint size = (uint)data.Length; Check(MsiRecordReadStream(record, 1, data, ref size)); if (size == 0) break; output.Write(data, 0, (int)size); }
        }
      } finally { MsiCloseHandle(record); }
    } finally { MsiCloseHandle(view); }
  }
  public void Dispose() { if (database != 0) { MsiCloseHandle(database); database = 0; } }
}
'@

$database = [ReadOnlyMsi]::new($MsiPath)
try {
  $properties = @($database.Query('SELECT `Property`, `Value` FROM `Property`') | ForEach-Object {
    if ($_[0] -in @('ProductName', 'ProductVersion', 'Manufacturer', 'ProductCode')) {
      [pscustomobject]@{ name = $_[0]; value = $_[1] }
    }
  })
  $files = @($database.Query('SELECT `File`, `Component_`, `FileName`, `FileSize`, `Sequence` FROM `File`') | ForEach-Object {
    [pscustomobject]@{ id = $_[0]; component = $_[1]; name = $_[2]; size = [long]$_[3]; sequence = [int]$_[4] }
  })
  $media = @($database.Query('SELECT `DiskId`, `LastSequence`, `Cabinet` FROM `Media`') | ForEach-Object {
    [pscustomobject]@{ disk = [int]$_[0]; last_sequence = [int]$_[1]; cabinet = $_[2] }
  })
  $directories = @($database.Query('SELECT `Directory`, `Directory_Parent`, `DefaultDir` FROM `Directory`') | ForEach-Object {
    [pscustomobject]@{ id = $_[0]; parent = $_[1]; name = $_[2] }
  })
  $components = @($database.Query('SELECT `Component`, `Directory_` FROM `Component`') | ForEach-Object {
    [pscustomobject]@{ id = $_[0]; directory = $_[1] }
  })
  [pscustomobject]@{
    mode = 'MsiOpenDatabaseW / MSIDBOPEN_READONLY'
    input_path = $MsiPath
    input_sha256 = (Get-FileHash -LiteralPath $MsiPath -Algorithm SHA256).Hash.ToLowerInvariant()
    properties = $properties; files = $files; media = $media; directories = $directories; components = $components
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'msi-inventory.json') -Encoding UTF8
  $properties | Format-Table
  $media | Format-Table
  $files | Where-Object { $_.name -match '(?i)(app\.asar|license|notice|wsl|docker|proxy)' } | Format-Table
  foreach ($item in $media) {
    if (-not $item.cabinet.StartsWith('#')) { throw 'External cabinet requires separate acquisition' }
    $cabinetPath = Join-Path $OutputDirectory ('media-' + $item.disk + '.cab')
    $database.CopyStream($item.cabinet.Substring(1), $cabinetPath)
    Get-Item -LiteralPath $cabinetPath | Select-Object FullName, Length
  }
} finally { $database.Dispose() }
