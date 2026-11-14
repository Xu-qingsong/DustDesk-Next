param([Parameter(Mandatory=$true)][string]$Configuration)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class FixtureWindow{[DllImport("user32.dll",SetLastError=true)]public static extern bool SetWindowDisplayAffinity(IntPtr handle,uint affinity);}'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Threading.Tasks;
public static class FixtureInput {
  public static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
  public static volatile bool Ended;
  public static void Start() {
    Task.Run(() => {
      try { string line; while ((line = Console.ReadLine()) != null) Lines.Enqueue(line); }
      finally { Ended = true; }
    });
  }
}
'@
[Windows.Forms.Application]::SetHighDpiMode([Windows.Forms.HighDpiMode]::PerMonitorV2) | Out-Null
$config=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Configuration))|ConvertFrom-Json
$windows=[Collections.Generic.Dictionary[string,Windows.Forms.Form]]::new()
function New-Fixture($value,$owner=$null){
  $form=[Windows.Forms.Form]::new()
  $form.Text=$value.title
  $form.AutoScaleMode=[Windows.Forms.AutoScaleMode]::None
  $form.FormBorderStyle=[Windows.Forms.FormBorderStyle]::None
  $form.StartPosition=[Windows.Forms.FormStartPosition]::Manual
  $form.Location=[Drawing.Point]::new($value.x,$value.y)
  $form.ClientSize=[Drawing.Size]::new($value.width,$value.height)
  $form.BackColor=[Drawing.Color]::FromArgb(56,178,100)
  $form.TopMost=$true
  if($value.split){$form.add_Paint({param($sender,$event)$brush=[Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(199,70,58));try{$event.Graphics.FillRectangle($brush,[int]($sender.ClientSize.Width/2),0,[int]($sender.ClientSize.Width/2),$sender.ClientSize.Height)}finally{$brush.Dispose()}})}
  $windows.Add($value.title,$form)
  if($null -eq $owner){$form.Show()}else{$form.Show($owner)}
  [Windows.Forms.Application]::DoEvents()
  return $form
}
$primary=New-Fixture $config
@{ready=$true;handle=$primary.Handle.ToInt64().ToString();width=$primary.ClientSize.Width;height=$primary.ClientSize.Height}|ConvertTo-Json -Compress
[FixtureInput]::Start()
try{
  while($true){
    $line=$null
    while(![FixtureInput]::Lines.TryDequeue([ref]$line)){
      if([FixtureInput]::Ended){break}
      [Windows.Forms.Application]::DoEvents();[Threading.Thread]::Sleep(20)
    }
    if($null -eq $line){break}
    $request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))|ConvertFrom-Json
    if($request.action -eq 'dispose'){break}
    try{
      $target=if($request.title){$windows[$request.title]}else{$primary}
      switch($request.action){
        'hide'{$target.Hide()}
        'show'{$target.WindowState=[Windows.Forms.FormWindowState]::Normal;$target.Show();$target.Activate()}
        'minimize'{$target.WindowState=[Windows.Forms.FormWindowState]::Minimized}
        'protect'{if(![FixtureWindow]::SetWindowDisplayAffinity($target.Handle,0x11)){throw 'Cannot protect fixture'}}
        'unprotect'{if(![FixtureWindow]::SetWindowDisplayAffinity($target.Handle,0)){throw 'Cannot unprotect fixture'}}
        'close'{$target.Close()}
        'owned'{$owned=New-Fixture $request $primary}
        default{throw 'Unknown native fixture action'}
      }
      [Windows.Forms.Application]::DoEvents()
      @{ok=$true}|ConvertTo-Json -Compress
    }catch{@{error=$_.Exception.Message}|ConvertTo-Json -Compress}
  }
}finally{foreach($window in $windows.Values){$window.Dispose()}}
