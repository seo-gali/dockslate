function Assert-DockSlateCliRegistration([string]$Expected) {
    $expectedPath = [IO.Path]::GetFullPath($Expected)
    $commands = @(Get-Command docker -CommandType Application,ExternalScript -All -ErrorAction SilentlyContinue)
    foreach ($command in $commands) {
        if ([IO.Path]::GetFullPath($command.Path).Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) { return }
    }
    throw ('The installed DockSlate CLI "' + $expectedPath + '" is missing from the registered Windows PATH. Other Docker installations and PATH entries were preserved.')
}

if ($MyInvocation.InvocationName -eq '.') { return }
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $expected = [Console]::In.ReadToEnd()
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    Assert-DockSlateCliRegistration $expected
    [Console]::Write('verified')
} catch {
    [Console]::Error.Write($_.Exception.Message)
    exit 1
}
