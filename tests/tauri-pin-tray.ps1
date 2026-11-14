param([int]$ProcessId,[string[]]$Captions,[switch]$KeyboardContext)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PinTrayClick {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int positionX,int positionY);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint deltaX,uint deltaY,uint data,UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeoutW(IntPtr hwnd,uint message,UIntPtr wParam,IntPtr lParam,uint flags,uint timeout,out UIntPtr result);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetMenuStringW(IntPtr menu,uint position,StringBuilder text,int count,uint flags);
  [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr menu,uint position,uint flags);
  [DllImport("user32.dll")] public static extern bool GetMenuItemRect(IntPtr hwnd,IntPtr menu,uint position,out Rect bounds);
  private delegate bool EnumWindow(IntPtr hwnd,IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback,IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hwnd,StringBuilder name,int count);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  public static IntPtr[] MenusForProcess(uint pid) {
    var found=new List<IntPtr>();
    EnumWindows((hwnd,parameter)=>{uint actual;GetWindowThreadProcessId(hwnd,out actual);if(actual==pid&&IsWindowVisible(hwnd)){var name=new StringBuilder(128);GetClassNameW(hwnd,name,name.Capacity);if(name.ToString()=="#32768")found.Add(hwnd);}return true;},IntPtr.Zero);
    return found.ToArray();
  }
}
'@
$root=[System.Windows.Automation.AutomationElement]::RootElement
function Point-At($Element) {
  $bounds=$Element.Current.BoundingRectangle
  if($bounds.IsEmpty -or $bounds.Width -lt 1 -or $bounds.Height -lt 1 -or $Element.Current.IsOffscreen){throw 'Tray target is not physically visible'}
  [void][PinTrayClick]::SetCursorPos([int]($bounds.X+$bounds.Width/2),[int]($bounds.Y+$bounds.Height/2))
}
function Click-Target($Element,[bool]$Right=$false) {
  Point-At $Element
  if($Right){$down=8;$up=16}else{$down=2;$up=4}
  [PinTrayClick]::mouse_event($down,0,0,0,[UIntPtr]::Zero)
  [PinTrayClick]::mouse_event($up,0,0,0,[UIntPtr]::Zero)
}
function Tray-Elements {
  $windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($window in $windows){
    if($window.Current.ClassName -in @('Shell_TrayWnd','Shell_SecondaryTrayWnd','NotifyIconOverflowWindow','TopLevelWindowForOverflowXamlIsland')){
      $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    }
  }
}
function Find-Tray {
  @(Tray-Elements)|Where-Object {$_.Current.Name -like '*DustDesk*' -and $_.Current.AutomationId -notlike 'Appid:*' -and -not $_.Current.IsOffscreen -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button}|Select-Object -First 1
}
function Find-Menu([string]$Caption) {
  foreach($nativeWindow in [PinTrayClick]::MenusForProcess([uint32]$ProcessId)){
    $handle=[UIntPtr]::Zero
    if([PinTrayClick]::SendMessageTimeoutW($nativeWindow,0x1e1,[UIntPtr]::Zero,[IntPtr]::Zero,2,1000,[ref]$handle) -eq [IntPtr]::Zero -or $handle -eq [UIntPtr]::Zero){continue}
    $menu=[IntPtr]::new([long]$handle.ToUInt64())
    for($position=0;$position -lt [PinTrayClick]::GetMenuItemCount($menu);$position++){
      $text=[Text.StringBuilder]::new(512)
      [void][PinTrayClick]::GetMenuStringW($menu,[uint32]$position,$text,$text.Capacity,0x400)
      # UIA can normalize a trailing F-key-looking suffix out of Name. Match
      # the complete native label, then click its actual displayed rectangle.
      if($text.ToString() -cne $Caption){continue}
      $bounds=[PinTrayClick+Rect]::new()
      if(-not [PinTrayClick]::GetMenuItemRect([IntPtr]::Zero,$menu,[uint32]$position,[ref]$bounds) -or $bounds.Right -le $bounds.Left -or $bounds.Bottom -le $bounds.Top){continue}
      $state=[PinTrayClick]::GetMenuState($menu,[uint32]$position,0x400)
      if($state -eq [uint32]::MaxValue){throw 'Native menu item state is unavailable'}
      $window=[System.Windows.Automation.AutomationElement]::FromHandle($nativeWindow)
      $uiaNames=@($window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)|Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem}|ForEach-Object {$_.Current.Name})
      [pscustomobject]@{name=$text.ToString();enabled=($state -band 3) -eq 0;bounds=$bounds;uiaNames=$uiaNames;menu=$menu.ToInt64();position=$position}
    }
  }
}
$openedOverflow=$false
$selected=$false
try {
  if($KeyboardContext){
    # Bring the notification area above a fullscreen selector before opening
    # its overflow; otherwise the selector receives that physical click.
    [PinTrayClick]::keybd_event(91,0,0,[UIntPtr]::Zero)
    [PinTrayClick]::keybd_event(66,0,0,[UIntPtr]::Zero)
    [PinTrayClick]::keybd_event(66,0,2,[UIntPtr]::Zero)
    [PinTrayClick]::keybd_event(91,0,2,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 180
  }
  $icon=Find-Tray
  if(-not $icon){
    $overflow=@(Tray-Elements)|Where-Object {$_.Current.AutomationId -eq 'SystemTray.OverflowButton' -or $_.Current.Name -in @('显示隐藏的图标','Show hidden icons')}|Select-Object -First 1
    if(-not $overflow){throw ('Tray icon and overflow control not found: '+(@(Tray-Elements)|ForEach-Object {$_.Current.Name+'|'+$_.Current.AutomationId}) -join ';')}
    if($KeyboardContext){
      $overflow.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    }else{Click-Target $overflow}
    $openedOverflow=$true
    $deadline=[DateTime]::UtcNow.AddSeconds(8)
    do{$icon=Find-Tray;if($icon){break};Start-Sleep -Milliseconds 80}while([DateTime]::UtcNow -lt $deadline)
  }
  if(-not $icon){throw ('DustDesk tray icon not found: '+(@(Tray-Elements)|ForEach-Object {$_.Current.Name+'|'+$_.Current.AutomationId}) -join ';')}
  $candidates=@(Tray-Elements)|Where-Object {$_.Current.Name -like '*DustDesk*' -and $_.Current.AutomationId -notlike 'Appid:*' -and -not $_.Current.IsOffscreen -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button}
  foreach($candidate in $candidates){try{Point-At $candidate;Start-Sleep -Milliseconds 180}catch{}}
  $icon=Find-Tray
  if(-not $icon){throw 'No live DustDesk tray icon remains after refreshing shell hover state'}
  $iconName=$icon.Current.Name
  Point-At $icon
  Start-Sleep -Milliseconds 180
  if($KeyboardContext){
    # Let Windows focus its notification area even when a fullscreen screenshot
    # covers the taskbar. Open the real Shell context menu using Shift+F10.
    $icon.SetFocus()
    [PinTrayClick]::keybd_event(16,0,0,[UIntPtr]::Zero)
    [PinTrayClick]::keybd_event(121,0,0,[UIntPtr]::Zero)
    [PinTrayClick]::keybd_event(121,0,2,[UIntPtr]::Zero)
    [PinTrayClick]::keybd_event(16,0,2,[UIntPtr]::Zero)
  }else{Click-Target $icon $true}
  $evidence=@()
  foreach($caption in $Captions){
    $deadline=[DateTime]::UtcNow.AddSeconds(8)
    do{$item=@(Find-Menu $caption)|Select-Object -First 1;if($item){break};Start-Sleep -Milliseconds 70}while([DateTime]::UtcNow -lt $deadline)
    if(-not $item){
      $diagnostics=@(foreach($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)){
        if($window.Current.ClassName -eq '#32768' -or $window.Current.ProcessId -eq $ProcessId){@{name=$window.Current.Name;class=$window.Current.ClassName;pid=$window.Current.ProcessId;items=@($window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)|Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem}|ForEach-Object {@{name=$_.Current.Name;offscreen=$_.Current.IsOffscreen}})}}
      })
      throw ('Native tray menu item not found: '+$caption+'; icon='+$iconName+'; menus='+($diagnostics|ConvertTo-Json -Depth 6 -Compress))
    }
    $evidence+=@{name=$item.name;enabled=$item.enabled;menu=$item.menu;position=$item.position;uiaNames=$item.uiaNames}
    if(-not $item.enabled){throw ('Native tray item disabled: '+$caption)}
    [void][PinTrayClick]::SetCursorPos([int](($item.bounds.Left+$item.bounds.Right)/2),[int](($item.bounds.Top+$item.bounds.Bottom)/2))
    [PinTrayClick]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    [PinTrayClick]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
    if($caption -eq $Captions[-1]){$selected=$true}
  }
  @{icon=$iconName;menu=$evidence;keyboardContext=[bool]$KeyboardContext}|ConvertTo-Json -Depth 4 -Compress
}finally{
  $popup=@($root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition))|Where-Object {$_.Current.ClassName -eq '#32768' -and $_.Current.ProcessId -eq $ProcessId}
  if(-not $selected -and $popup){[PinTrayClick]::keybd_event(27,0,0,[UIntPtr]::Zero);[PinTrayClick]::keybd_event(27,0,2,[UIntPtr]::Zero)}
  if($openedOverflow){
    $open=@($root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition))|Where-Object {$_.Current.ClassName -in @('NotifyIconOverflowWindow','TopLevelWindowForOverflowXamlIsland') -and -not $_.Current.IsOffscreen}
    if($open -and $overflow -and -not $overflow.Current.IsOffscreen){Click-Target $overflow}
  }
}
