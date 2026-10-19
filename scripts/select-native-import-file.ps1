param([Parameter(Mandatory=$true)][int]$TargetProcessId,[string]$Path,[switch]$Cancel)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ImportDialogControls {
  public delegate bool Visitor(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, Visitor visit, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint message, IntPtr w, string l);
  [DllImport("user32.dll", EntryPoint="SendMessageW")] public static extern IntPtr SendButton(IntPtr h, uint message, IntPtr w, IntPtr l);
}
'@
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$TargetProcessId)
$deadline = (Get-Date).AddSeconds(20)
$dialog = $null
while (-not $dialog -and (Get-Date) -lt $deadline) {
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
    $dialog = @($windows | Where-Object {$_.Current.ClassName -eq '#32770'}) | Select-Object -First 1
    if (-not $dialog) { Start-Sleep -Milliseconds 100 }
}
if (-not $dialog) { throw 'The target DockSlate native file dialog did not appear' }
if ($dialog.Current.Name -notmatch 'Dockerfile|Compose') { throw 'Refusing to automate an unrelated dialog' }
$script:fileEdit = [IntPtr]::Zero
$script:openButton = [IntPtr]::Zero
$script:cancelButton = [IntPtr]::Zero
$visitor = [ImportDialogControls+Visitor]{ param($handle,$unused)
    $class = New-Object System.Text.StringBuilder 128
    [void][ImportDialogControls]::GetClassName($handle,$class,128)
    $id = [ImportDialogControls]::GetDlgCtrlID($handle)
    if ($id -eq 1148 -and $class.ToString() -eq 'Edit') {$script:fileEdit=$handle}
    if ($id -eq 1 -and $class.ToString() -eq 'Button') {$script:openButton=$handle}
    if ($id -eq 2 -and $class.ToString() -eq 'Button') {$script:cancelButton=$handle}
    return $true
}
[void][ImportDialogControls]::EnumChildWindows([IntPtr]$dialog.Current.NativeWindowHandle,$visitor,[IntPtr]::Zero)
if ($Cancel) {
    if ($script:cancelButton -eq [IntPtr]::Zero) { throw 'Native Cancel button missing' }
    [void][ImportDialogControls]::SendButton($script:cancelButton,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)
} else {
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $fixtureRoot = Join-Path $workspace '.analysis\file-import-fixture-'
    if (-not $resolved.StartsWith($fixtureRoot,[StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw 'Only isolated import fixture files are permitted' }
    if ($script:fileEdit -eq [IntPtr]::Zero -or $script:openButton -eq [IntPtr]::Zero) { throw 'Native file-name/Open controls missing' }
    [void][ImportDialogControls]::SendMessage($script:fileEdit,0x000C,[IntPtr]::Zero,$resolved)
    [void][ImportDialogControls]::SendButton($script:openButton,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)
}
[ordered]@{processId=$TargetProcessId;dialogClass='#32770';filenameControlId=1148;action=$(if ($Cancel) {'cancel'} else {'select'});title=$dialog.Current.Name} | ConvertTo-Json -Compress
