$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class ClipboardLock{[DllImport("user32.dll")]public static extern bool OpenClipboard(IntPtr owner);[DllImport("user32.dll")]public static extern bool CloseClipboard();[DllImport("user32.dll")]public static extern uint GetClipboardSequenceNumber();}'
if(-not [ClipboardLock]::OpenClipboard([IntPtr]::Zero)){throw 'Cannot lock clipboard for contention test'}
try{
  $sequence=[ClipboardLock]::GetClipboardSequenceNumber()
  [Console]::WriteLine('ready')
  [Console]::Out.Flush()
  [void][Console]::ReadLine()
  if([ClipboardLock]::GetClipboardSequenceNumber() -ne $sequence){throw 'Clipboard changed while exclusively locked'}
}finally{[void][ClipboardLock]::CloseClipboard()}
