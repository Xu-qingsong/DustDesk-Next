param([int]$ProcessId,[string]$Action='snapshot',[string]$Title='发现新版本')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DustDeskUpdateDialog {
    public delegate bool EnumCallback(IntPtr handle,IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback,IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle,out uint processId);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr handle,StringBuilder name,int length);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle,uint message,IntPtr first,IntPtr second);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr handle,uint message,IntPtr first,IntPtr second);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int horizontal,int vertical);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint horizontal,uint vertical,uint data,UIntPtr extra);
    public static IntPtr Tray(int expected) {
        IntPtr found=IntPtr.Zero;
        EnumWindows((handle,parameter)=>{
            uint processId; GetWindowThreadProcessId(handle,out processId);
            var name=new StringBuilder(256); GetClassName(handle,name,name.Capacity);
            if(processId==expected && name.ToString()=="tray_icon_app") found=handle;
            return true;
        },IntPtr.Zero);
        if(found==IntPtr.Zero) throw new InvalidOperationException("Native tray window missing");
        return found;
    }
}
'@
$root=[System.Windows.Automation.AutomationElement]::RootElement
$process=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$ProcessId)
if($Action -in @('tray-update','tray-quit')) {
    $handle=[DustDeskUpdateDialog]::Tray($ProcessId)
    if(-not [DustDeskUpdateDialog]::PostMessage($handle,6002,[IntPtr]::Zero,[IntPtr]0x205)){throw 'Native tray menu request failed'}
    $name=if($Action -eq 'tray-update'){'检查更新'}else{'退出 DustDesk'}
    $condition=[System.Windows.Automation.AndCondition]::new($process,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$name),[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::MenuItem))
}else{
    $condition=[System.Windows.Automation.AndCondition]::new($process,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$Title),[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window))
}
$deadline=[DateTime]::UtcNow.AddSeconds(10)
$target=$null
while(-not $target -and [DateTime]::UtcNow -lt $deadline){$target=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition);if(-not $target){Start-Sleep -Milliseconds 60}}
if(-not $target){
    $windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$process)
    $details=@($windows|ForEach-Object{$_.Current.Name; $_.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)|ForEach-Object{$_.Current.Name}}) -join ' | '
    throw "Native update target missing: $Action $Title; process UI: $details"
}
if($Action -in @('tray-update','tray-quit')) {
    $bounds=$target.Current.BoundingRectangle
    if($bounds.IsEmpty){throw 'Native tray item has no hit target'}
    [void][DustDeskUpdateDialog]::SetCursorPos([int]($bounds.X+$bounds.Width/2),[int]($bounds.Y+$bounds.Height/2))
    [DustDeskUpdateDialog]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    [DustDeskUpdateDialog]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
    'completed';exit
}
$controls=$target.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
if($Action -eq 'snapshot') {
    @{controls=@($controls|ForEach-Object{@{name=$_.Current.Name;id=$_.Current.AutomationId;type=$_.Current.ControlType.ProgrammaticName}})}|ConvertTo-Json -Depth 4 -Compress
    exit
}
if($Action -eq 'default') {
    $handle=[IntPtr]$target.Current.NativeWindowHandle
    [void][DustDeskUpdateDialog]::SetForegroundWindow($handle)
    if([DustDeskUpdateDialog]::GetForegroundWindow() -ne $handle){throw 'Update dialog did not receive keyboard focus'}
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    'completed';exit
}
$name=switch($Action){'accept'{'前往更新'}'decline'{'暂不更新'}'dismiss'{'确定'}default{throw 'Unknown update dialog operation'}}
$button=$controls|Where-Object{$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq $name}|Select-Object -First 1
if(-not $button){throw "Native update button missing: $name"}
$invoke=$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
'completed'
