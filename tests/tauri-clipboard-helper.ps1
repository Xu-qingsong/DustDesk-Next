$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
[Console]::InputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class ClipboardSequence{[DllImport("user32.dll")]public static extern uint GetClipboardSequenceNumber();}'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClipboardDibFixture {
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr handle);
    public static void Hold() {
        for (int attempt = 0; attempt < 40; attempt++) {
            if (OpenClipboard(IntPtr.Zero)) return;
            System.Threading.Thread.Sleep(25);
        }
        throw new InvalidOperationException("Clipboard is busy");
    }
    public static void Release() { CloseClipboard(); }
    public static string Read(uint format) {
        if (!OpenClipboard(IntPtr.Zero)) throw new InvalidOperationException("Clipboard is busy");
        try {
            var handle = GetClipboardData(format);
            if (handle == IntPtr.Zero) return null;
            var length = GlobalSize(handle).ToUInt64();
            if (length == 0 || length > 1024 * 1024) throw new InvalidOperationException("Fixture DIB is too large");
            var data = GlobalLock(handle);
            if (data == IntPtr.Zero) throw new InvalidOperationException("Cannot lock fixture DIB");
            try { var bytes = new byte[(int)length]; Marshal.Copy(data, bytes, 0, bytes.Length); return Convert.ToBase64String(bytes); }
            finally { GlobalUnlock(handle); }
        } finally { CloseClipboard(); }
    }
}
'@
$backup=$null
$owned=[Collections.Generic.List[IDisposable]]::new()
$source=[Windows.Forms.Clipboard]::GetDataObject()
if($null -ne $source){
  $backup=[Windows.Forms.DataObject]::new()
  foreach($format in $source.GetFormats($false)){
    $value=$source.GetData($format,$false)
    if($null -eq $value){throw "Cannot preserve clipboard format: $format"}
    if($value -is [IO.MemoryStream]){$value=[IO.MemoryStream]::new($value.ToArray());$owned.Add($value)}
    elseif($value -is [Drawing.Image]){$value=$value.Clone();$owned.Add($value)}
    $backup.SetData($format,$false,$value)
  }
}
try{
  $held=$false
  @{ready=$true}|ConvertTo-Json -Compress
  while($null -ne ($line=[Console]::ReadLine())){
    $command=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))|ConvertFrom-Json
    if($command.action -eq 'restore'){break}
    $result=@{}
    switch($command.action){
      'set-text'{[Windows.Forms.Clipboard]::SetText([string]$command.text)}
      'set-text-locked'{[Windows.Forms.Clipboard]::SetText([string]$command.text);[ClipboardDibFixture]::Hold();$held=$true}
      'unlock'{[ClipboardDibFixture]::Release();$held=$false}
      'clear'{[Windows.Forms.Clipboard]::Clear()}
      'set-bitmap'{
        $bitmap=[Drawing.Bitmap]::new(3,2)
        try{for($column=0;$column -lt 3;$column++){for($row=0;$row -lt 2;$row++){$bitmap.SetPixel($column,$row,[Drawing.Color]::FromArgb(255,10+$column,20+$row,30))}};[Windows.Forms.Clipboard]::SetImage($bitmap)}finally{$bitmap.Dispose()}
      }
      'inspect'{
        $result.text=[Windows.Forms.Clipboard]::GetText()
        $result.formats=@([Windows.Forms.Clipboard]::GetDataObject().GetFormats($false))
        $image=[Windows.Forms.Clipboard]::GetImage()
        if($null -ne $image){try{$color=$image.GetPixel(0,0);$result.image=@{width=$image.Width;height=$image.Height;first=@($color.R,$color.G,$color.B,$color.A)}}finally{$image.Dispose()}}
      }
      'sequence'{}
      'inspect-dib'{$result.dib=[ClipboardDibFixture]::Read(8);$result.dibv5=[ClipboardDibFixture]::Read(17)}
      default{throw 'Unknown clipboard fixture action'}
    }
    $result.sequence=[ClipboardSequence]::GetClipboardSequenceNumber()
    $result|ConvertTo-Json -Depth 6 -Compress
  }
}finally{
  if($held){[ClipboardDibFixture]::Release()}
  $restored=$false
  for($attempt=0;$attempt -lt 30;$attempt++){
    try{if($null -eq $backup){[Windows.Forms.Clipboard]::Clear()}else{[Windows.Forms.Clipboard]::SetDataObject($backup,$true)};$restored=$true;break}catch{Start-Sleep -Milliseconds 30}
  }
  foreach($value in $owned){$value.Dispose()}
  if(-not $restored){throw 'Could not restore the original clipboard formats'}
  @{restored=$true}|ConvertTo-Json -Compress
}
