param([int]$ProcessId,[ValidateSet('snapshot','restore','keep','cancel')][string]$Action='snapshot')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OrganizerQuitDialog {
  public delegate bool WindowCallback(IntPtr window,IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(WindowCallback callback,IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window,StringBuilder text,int maximum);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window,int identifier);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr first,IntPtr second);
}
'@
$script:dialog=[IntPtr]::Zero
$deadline=[DateTime]::UtcNow.AddSeconds(12)
do {
  [void][OrganizerQuitDialog]::EnumWindows({param($window,$parameter)
    [uint32]$owner=0
    [void][OrganizerQuitDialog]::GetWindowThreadProcessId($window,[ref]$owner)
    if($owner -eq $ProcessId){
      $text=New-Object Text.StringBuilder 256
      [void][OrganizerQuitDialog]::GetWindowText($window,$text,256)
      $title=([string][char]0x9000)+([char]0x51FA)+' DustDesk'
      if($text.ToString() -eq $title){$script:dialog=$window;return $false}
    }
    return $true
  },[IntPtr]::Zero)
  if($script:dialog -ne [IntPtr]::Zero){break}
  Start-Sleep -Milliseconds 50
} while([DateTime]::UtcNow -lt $deadline)
if($script:dialog -eq [IntPtr]::Zero){throw 'Organizer quit confirmation was not found in the test process'}
$default=([OrganizerQuitDialog]::SendMessage($script:dialog,0x400,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -band 0xffff)
if($Action -ne 'snapshot'){
  $identifier=@{restore=6;keep=7;cancel=2}[$Action]
  $button=[OrganizerQuitDialog]::GetDlgItem($script:dialog,$identifier)
  if($button -eq [IntPtr]::Zero){throw 'Native quit confirmation button missing'}
  [void][OrganizerQuitDialog]::SendMessage($button,0xF5,[IntPtr]::Zero,[IntPtr]::Zero)
}
@{processId=$ProcessId;action=$Action;defaultButton=$default}|ConvertTo-Json -Compress
