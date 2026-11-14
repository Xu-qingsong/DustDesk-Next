param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
$reader = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
try {
  $before = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($reader)).ToLowerInvariant()
  [Console]::WriteLine('ready:' + $before)
  [Console]::Out.Flush()
  [void][Console]::ReadLine()
  $reader.Position = 0
  $after = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($reader)).ToLowerInvariant()
  [Console]::WriteLine((@{ before=$before; after=$after; unchanged=($before -eq $after) } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
} finally { $reader.Dispose() }
