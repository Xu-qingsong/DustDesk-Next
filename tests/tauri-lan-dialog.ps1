param([int]$ProcessId,[string]$Title,[ValidateSet('snapshot','click','default','escape','absent')][string]$Action='snapshot',[string]$Button)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DustDeskLanDialog {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$root=[System.Windows.Automation.AutomationElement]::RootElement
$process=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$ProcessId)
$condition=[System.Windows.Automation.AndCondition]::new($process,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$Title),[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window))
$dialog=$null
$deadline=[DateTime]::UtcNow.AddSeconds(10)
do {
    $dialog=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
    if($dialog -or $Action -eq 'absent'){break}
    Start-Sleep -Milliseconds 50
}while([DateTime]::UtcNow -lt $deadline)
if($Action -eq 'absent') { @{absent=($null -eq $dialog)} | ConvertTo-Json -Compress; exit }
if(-not $dialog){
    $windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$process)
    $details=@($windows|ForEach-Object{@{name=$_.Current.Name;class=$_.Current.ClassName;type=$_.Current.ControlType.ProgrammaticName;controls=@($_.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)|ForEach-Object{$_.Current.Name})}})|ConvertTo-Json -Depth 5 -Compress
    throw "Native LAN dialog missing: $Title; process UI: $details"
}
$controls=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
if($Action -eq 'snapshot') {
    @{visible=(-not $dialog.Current.IsOffscreen);controls=@($controls|ForEach-Object{@{name=$_.Current.Name;id=$_.Current.AutomationId;type=$_.Current.ControlType.ProgrammaticName;focused=$_.Current.HasKeyboardFocus}})} | ConvertTo-Json -Depth 4 -Compress
    exit
}
if($Action -in @('default','escape')) {
    $window=[IntPtr]$dialog.Current.NativeWindowHandle
    [void][DustDeskLanDialog]::SetForegroundWindow($window)
    if([DustDeskLanDialog]::GetForegroundWindow() -ne $window){throw 'LAN dialog did not receive keyboard focus'}
    $key=if($Action -eq 'default'){'{ENTER}'}else{'{ESC}'}
    [System.Windows.Forms.SendKeys]::SendWait($key)
}else{
    # TaskDialog can enter the UIA tree before its buttons are populated.
    $deadline=[DateTime]::UtcNow.AddSeconds(5)
    do {
        $controls=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
        $target=$controls|Where-Object{$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq $Button -and $_.Current.IsEnabled}|Select-Object -First 1
        if($target){break}
        Start-Sleep -Milliseconds 50
    }while([DateTime]::UtcNow -lt $deadline)
    if(-not $target){throw ("Native LAN button missing: $Button; controls: "+(@($controls|ForEach-Object{$_.Current.Name})|ConvertTo-Json -Compress))}
    $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
'completed'
