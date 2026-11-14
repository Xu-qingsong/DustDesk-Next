param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$KeyHash,
    [ValidateSet('inspect', 'seed-other', 'seed-foreign', 'seed-type', 'deny-write', 'allow-write', 'cleanup')][string]$Action = 'inspect',
    [int]$AppProcessId = 0
)
$ErrorActionPreference = 'Stop'
$basePath = 'Software\DustDesk\TauriMigrationTests\' + $KeyHash
$runPath = $basePath + '\Run'
$entryName = 'DustDesk'
$hive = [Microsoft.Win32.Registry]::CurrentUser
if ($Action -in @('deny-write', 'allow-write', 'cleanup')) {
    $rights = [Security.AccessControl.RegistryRights]::ReadPermissions -bor [Security.AccessControl.RegistryRights]::ChangePermissions
    $key = $hive.OpenSubKey($runPath, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, $rights)
    if ($null -ne $key) {
        try {
            $security = [Microsoft.Win32.RegistryAclExtensions]::GetAccessControl($key)
            $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
            try { $rule = [Security.AccessControl.RegistryAccessRule]::new($identity.User, [Security.AccessControl.RegistryRights]::SetValue, [Security.AccessControl.AccessControlType]::Deny) }
            finally { $identity.Dispose() }
            if ($Action -eq 'deny-write') { $security.AddAccessRule($rule) }
            else { $security.RemoveAccessRuleSpecific($rule) }
            [Microsoft.Win32.RegistryAclExtensions]::SetAccessControl($key, $security)
        } finally { $key.Dispose() }
    }
}
if ($Action -eq 'cleanup') {
    $hive.DeleteSubKeyTree($basePath, $false)
} elseif ($Action -in @('seed-other', 'seed-foreign', 'seed-type')) {
    $key = $hive.CreateSubKey($runPath)
    try {
        switch ($Action) {
            'seed-other' { $key.SetValue('UnrelatedApp', 'leave-this-alone', [Microsoft.Win32.RegistryValueKind]::String) }
            'seed-foreign' { $key.SetValue($entryName, '"C:\Other App\Other.exe" --not-dustdesk', [Microsoft.Win32.RegistryValueKind]::String) }
            'seed-type' { $key.SetValue($entryName, 7, [Microsoft.Win32.RegistryValueKind]::DWord) }
        }
    } finally { $key.Dispose() }
}
$key = $hive.OpenSubKey($runPath)
$values = @{}
try {
    if ($null -ne $key) {
        foreach ($name in $key.GetValueNames()) {
            $values[$name] = @{ Value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); Kind = $key.GetValueKind($name).ToString() }
        }
    }
} finally { if ($null -ne $key) { $key.Dispose() } }
$production = $hive.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
$productionValue = $null
try {
    if ($null -ne $production -and $production.GetValueNames() -contains $entryName) {
        $productionValue = @{ Value = $production.GetValue($entryName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); Kind = $production.GetValueKind($entryName).ToString() }
    }
} finally { if ($null -ne $production) { $production.Dispose() } }
$processes = @()
if ($AppProcessId -gt 0) {
    $rows = @(Get-CimInstance Win32_Process)
    $ids = [Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($AppProcessId)
    do {
        $added = $false
        foreach ($row in $rows) {
            if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $added = $true }
        }
    } while ($added)
    $processes = @($rows | Where-Object { $ids.Contains([int]$_.ProcessId) } | Select-Object ProcessId,Name)
}
@{ Values = $values; Exists = ($null -ne $key); ProductionPreviewValue = $productionValue; Processes = $processes } | ConvertTo-Json -Depth 6 -Compress
