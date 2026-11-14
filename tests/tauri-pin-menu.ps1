param([int]$ProcessId,[string]$Caption='')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root=[System.Windows.Automation.AutomationElement]::RootElement
$condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$ProcessId)
$deadline=[DateTime]::UtcNow.AddSeconds(12)
$items=@()
do {
  $windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
  $items=@(foreach($window in $windows){$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)|Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem -and $_.Current.Name -in @('恢复原始比例','复制','保存…','重新编辑','关闭贴图','置顶','锁定位置','鼠标穿透')}})
  if($items.Count -ge 8){break}
  Start-Sleep -Milliseconds 60
}while([DateTime]::UtcNow -lt $deadline)
if($items.Count -lt 8){throw 'Expected native pin menu was not found'}
if(-not $Caption){@($items|ForEach-Object {@{name=$_.Current.Name;enabled=$_.Current.IsEnabled}})|ConvertTo-Json -Compress;exit}
$button=$items|Where-Object {$_.Current.Name -eq $Caption}|Select-Object -First 1
if(-not $button){throw 'Requested pin menu item was not found'}
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class PinMenuClick{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);}'
$bounds=$button.Current.BoundingRectangle
if($bounds.IsEmpty -or $bounds.Width -lt 1 -or $bounds.Height -lt 1){throw 'Native pin menu item has no physical click target'}
[void][PinMenuClick]::SetCursorPos([int]($bounds.X+$bounds.Width/2),[int]($bounds.Y+$bounds.Height/2))
[PinMenuClick]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
[PinMenuClick]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
'completed'
