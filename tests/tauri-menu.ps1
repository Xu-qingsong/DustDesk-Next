param([int]$ProcessId,[string]$Action='snapshot',[string]$ExpectedPath='')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$ProcessId)
$root=[System.Windows.Automation.AutomationElement]::RootElement
$deadline=[DateTime]::UtcNow.AddSeconds(12)
$items=@()
do {
  $windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
  $items=@(foreach($window in $windows){$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)|Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem -and $_.Current.Name -in @('打开','在资源管理器中显示','复制路径') }})
  if($items.Count -eq 3){break}
  Start-Sleep -Milliseconds 60
}while([DateTime]::UtcNow -lt $deadline)
if($items.Count -ne 3){throw 'Expected native path menu was not found'}
if($Action -eq 'snapshot'){@($items|ForEach-Object {@{name=$_.Current.Name;enabled=$_.Current.IsEnabled}})|ConvertTo-Json -Compress;exit}
$name=switch($Action){'open'{'打开'}'reveal'{'在资源管理器中显示'}'copy'{'复制路径'}'copy-busy'{'复制路径'}default{throw 'Unknown native menu operation'}}
$button=$items|Where-Object {$_.Current.Name -eq $name}|Select-Object -First 1
$backup=$null
if($Action -eq 'copy'){
  $source=[System.Windows.Forms.Clipboard]::GetDataObject()
  if($null -ne $source){
    $backup=New-Object System.Windows.Forms.DataObject
    foreach($format in $source.GetFormats($false)){
      $value=$source.GetData($format,$false)
      if($null -ne $value){$backup.SetData($format,$false,$value)}
    }
  }
}
try{
  Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class DustDeskNativeMenuClick{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);}'
  $bounds=$button.Current.BoundingRectangle
  if($bounds.IsEmpty -or $bounds.Width -lt 1 -or $bounds.Height -lt 1){throw 'Native menu item has no physical click target'}
  [void][DustDeskNativeMenuClick]::SetCursorPos([int]($bounds.X+$bounds.Width/2),[int]($bounds.Y+$bounds.Height/2))
  [DustDeskNativeMenuClick]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  [DustDeskNativeMenuClick]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  if($Action -eq 'copy'){
    $deadline=[DateTime]::UtcNow.AddSeconds(6)
    do{Start-Sleep -Milliseconds 30;$text=[System.Windows.Forms.Clipboard]::GetText();if($text -eq $ExpectedPath){break}}while([DateTime]::UtcNow -lt $deadline)
    if($text -ne $ExpectedPath){throw 'Native menu did not copy the expected exact Unicode path'}
  }
  'completed'
}finally{
  if($Action -eq 'copy'){
    $restored=$false
    for($attempt=0;$attempt -lt 30;$attempt++){
      try{if($null -eq $backup){[System.Windows.Forms.Clipboard]::Clear()}else{[System.Windows.Forms.Clipboard]::SetDataObject($backup,$true)};$restored=$true;break}catch{Start-Sleep -Milliseconds 30}
    }
    if(-not $restored){throw 'Could not restore the clipboard after the native copy verification'}
  }
}
