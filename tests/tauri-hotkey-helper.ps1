$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class DustDeskHotkeyFixture {
  [DllImport("user32.dll",SetLastError=true)] public static extern bool RegisterHotKey(IntPtr window,int id,uint modifiers,uint key);
  [DllImport("user32.dll",SetLastError=true)] public static extern bool UnregisterHotKey(IntPtr window,int id);
  [DllImport("user32.dll")] static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
  public static void Press(byte key) {
    byte[] modifiers={0x11,0x12,0x10};
    foreach(byte modifier in modifiers) keybd_event(modifier,0,0,UIntPtr.Zero);
    keybd_event(key,0,0,UIntPtr.Zero); Thread.Sleep(50); keybd_event(key,0,2,UIntPtr.Zero);
    for(int index=modifiers.Length-1;index>=0;index--)keybd_event(modifiers[index],0,2,UIntPtr.Zero);
  }
}
'@
$registered=[Collections.Generic.HashSet[int]]::new()
$stream=$null
try {
  @{ready=$true}|ConvertTo-Json -Compress
  while($null -ne ($line=[Console]::ReadLine())) {
    $request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))|ConvertFrom-Json
    $result=@{ok=$true}
    switch($request.action) {
      'press' { [DustDeskHotkeyFixture]::Press([byte]$request.key) }
      'hold' {
        $key=[int]$request.key
        if($key -lt 124 -or $key -gt 135){throw 'Only isolated F13-F24 fixtures are allowed'}
        $result.ok=[DustDeskHotkeyFixture]::RegisterHotKey([IntPtr]::Zero,$key,0x4007,[uint32]$key)
        $result.error=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if($result.ok){[void]$registered.Add($key)}
      }
      'release' { $key=[int]$request.key; $result.ok=[DustDeskHotkeyFixture]::UnregisterHotKey([IntPtr]::Zero,$key); [void]$registered.Remove($key) }
      'lock' {
        $target=[IO.Path]::GetFullPath([string]$request.path)
        $temporary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if(-not $target.StartsWith($temporary,[StringComparison]::OrdinalIgnoreCase) -or $target -notmatch 'dustdesk-tauri-test-' -or [IO.Path]::GetFileName($target) -ne 'workspace.json'){throw 'Only isolated workspace files may be locked'}
        $stream=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
      }
      'unlock' { if($stream){$stream.Dispose();$stream=$null} }
      'stop' { break }
      default { throw 'Unknown native shortcut fixture action' }
    }
    $result|ConvertTo-Json -Compress
    if($request.action -eq 'stop'){break}
  }
} finally {
  if($stream){$stream.Dispose()}
  foreach($key in $registered){[void][DustDeskHotkeyFixture]::UnregisterHotKey([IntPtr]::Zero,$key)}
}
