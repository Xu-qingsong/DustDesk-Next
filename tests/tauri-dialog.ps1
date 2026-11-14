param([int]$ProcessId,[string]$Title,[ValidateSet('visible','snapshot','select','current','cancel','confirm')][string]$Action='snapshot',[string]$Path)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DustDeskFileDialogControls {
  private delegate bool EnumChild(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumChild callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr handle);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr handle);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr handle,StringBuilder name,int size);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr handle,uint message,IntPtr first,string second,uint flags,uint timeout,out IntPtr result);
  [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(IntPtr handle,uint message,IntPtr first,IntPtr second,uint flags,uint timeout,out IntPtr result);
  public static bool Select(IntPtr dialog,string path,bool cancel) {
    IntPtr edit=IntPtr.Zero,button=IntPtr.Zero;
    EnumChildWindows(dialog,(handle,unused)=>{
      int id=GetDlgCtrlID(handle);
      if(IsWindowVisible(handle)&&IsWindowEnabled(handle)){
        var name=new StringBuilder(128);GetClassName(handle,name,name.Capacity);
        if(id==1148&&(name.ToString()=="Edit"||name.ToString()=="ComboBox"||name.ToString()=="ComboBoxEx32"))edit=handle;
        if(id==(cancel?2:1)&&name.ToString()=="Button")button=handle;
      }
      return true;
    },IntPtr.Zero);
    if(button==IntPtr.Zero||(!cancel&&edit==IntPtr.Zero))return false;
    IntPtr result;
    if(!cancel&&SendMessageTimeout(edit,0x000c,IntPtr.Zero,path,2,3000,out result)==IntPtr.Zero)throw new InvalidOperationException("Native file name entry timed out");
    if(SendMessageTimeout(button,0x00f5,IntPtr.Zero,IntPtr.Zero,2,3000,out result)==IntPtr.Zero)throw new InvalidOperationException("Native file selection timed out");
    return true;
  }
}
'@
$root=[System.Windows.Automation.AutomationElement]::RootElement
$condition=[System.Windows.Automation.AndCondition]::new([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$ProcessId),[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$Title),[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window))
$dialog=$null
$deadline=[DateTime]::UtcNow.AddSeconds(12)
while (-not $dialog -and [DateTime]::UtcNow -lt $deadline) {
  $dialog=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
  if (-not $dialog) { Start-Sleep -Milliseconds 100 }
}
if (-not $dialog) {throw "Dialog not found: $Title"}
if ($Action -eq 'visible') {
  if ($dialog.Current.NativeWindowHandle -eq 0 -or $dialog.Current.IsOffscreen) {throw "Native dialog is not visible: $Title"}
  @{processId=$dialog.Current.ProcessId;title=$dialog.Current.Name;handle=$dialog.Current.NativeWindowHandle;visible=$true}|ConvertTo-Json -Compress
  exit
}
if ($Action -eq 'confirm') {
  if ($Title -notmatch '^(确认另存为|Confirm Save As)$') {throw 'Unexpected confirmation dialog title'}
  $button=$null
  while (-not $button -and [DateTime]::UtcNow -lt $deadline) {
    $controls=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $button=$controls | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.AutomationId -eq 'CommandButton_6' -and $_.Current.Name -match '^(是|Yes)'} | Select-Object -First 1
    if (-not $button) {Start-Sleep -Milliseconds 100}
  }
  if (-not $button) {throw 'Native overwrite confirmation button not found'}
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  'confirmed'
  exit
}
$ready=$false
do {
  $controls=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $primary=$controls | Where-Object {$_.Current.ClassName -eq 'Button' -and $_.Current.NativeWindowHandle -ne 0 -and $_.Current.AutomationId -eq '1' -and $_.Current.Name -match '^(打开|Open|保存|Save|选择文件夹|Select Folder)'} | Select-Object -Last 1
  $cancel=$controls | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -match '^(取消|Cancel)'} | Select-Object -First 1
  $edit=$controls | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and ($_.Current.AutomationId -eq '1148' -or $_.Current.Name -match '^(文件名|File name|文件夹|Folder)[:：]?$')} | Select-Object -Last 1
  $ready=$null -ne $primary -and $null -ne $cancel -and $null -ne $edit
  # Shell's accessibility provider can expose only its folder view. Use the
  # same standard native dialog controls when that provider omits them.
  if(-not $ready -and $Action -in @('select','cancel') -and [DustDeskFileDialogControls]::Select([IntPtr]$dialog.Current.NativeWindowHandle,$Path,($Action -eq 'cancel'))){'completed';exit}
  if(-not $ready){Start-Sleep -Milliseconds 100}
}while(-not $ready -and [DateTime]::UtcNow -lt $deadline)
if(-not $ready){
  $details=@($controls|Where-Object{$_.Current.AutomationId -eq '1' -or $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -or $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button}|ForEach-Object{@{name=$_.Current.Name;id=$_.Current.AutomationId;type=$_.Current.ControlType.ProgrammaticName;className=$_.Current.ClassName}})|ConvertTo-Json -Compress
  throw "Native file dialog controls are not ready: $Title $details"
}
if ($Action -eq 'snapshot') {
  @($controls | Where-Object {$_.Current.AutomationId -eq '1' -or $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -or $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button} | ForEach-Object {@{name=$_.Current.Name;id=$_.Current.AutomationId;type=$_.Current.ControlType.ProgrammaticName;className=$_.Current.ClassName;enabled=$_.Current.IsEnabled}}) | ConvertTo-Json -Compress
  exit
}
if ($Action -eq 'cancel') {
  $button=$controls | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -match '^(取消|Cancel)'} | Select-Object -First 1
} else {
  if (-not $edit) {throw 'File name edit not found'}
  $pattern=$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $pattern.SetValue($Path)
  $button=$primary
}
if (-not $button) {throw 'Dialog action button not found'}
$invoke=$null
if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)) { $invoke.Invoke() } else {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DustDeskDialogClick { [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam); }'
  [void][DustDeskDialogClick]::SendMessage([IntPtr]$button.Current.NativeWindowHandle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)
}
if ($Action -eq 'current') {
  Start-Sleep -Milliseconds 250
  $controls=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $button=$controls | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq '选择当前文件夹'} | Select-Object -First 1
  if (-not $button) {throw 'Current folder button not found'}
  $invoke=$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $invoke.Invoke()
}
'completed'
