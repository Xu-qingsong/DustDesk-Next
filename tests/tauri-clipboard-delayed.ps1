param([switch]$Image)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class DustDeskDelayedClipboard {
    delegate IntPtr Procedure(IntPtr window,uint message,IntPtr parameter,IntPtr data);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct WindowClass {
        public uint Style; public IntPtr Callback; public int ClassExtra; public int WindowExtra;
        public IntPtr Instance; public IntPtr Icon; public IntPtr Cursor; public IntPtr Background;
        public string Menu; public string Name;
    }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int Horizontal; public int Vertical; }
    [StructLayout(LayoutKind.Sequential)] struct Message {
        public IntPtr Window; public uint Kind; public IntPtr Parameter; public IntPtr Data;
        public uint Time; public Point Position; public uint PrivateData;
    }
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern ushort RegisterClassW(ref WindowClass definition);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowExW(uint extended,string name,string title,uint style,int horizontal,int vertical,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr window,uint message,IntPtr parameter,IntPtr data);
    [DllImport("user32.dll")] static extern int GetMessageW(out Message message,IntPtr window,uint first,uint last);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref Message message);
    [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr window,uint message,IntPtr parameter,IntPtr data);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
    [DllImport("user32.dll",SetLastError=true)] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll",SetLastError=true)] static extern bool EmptyClipboard();
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetClipboardData(uint format,IntPtr memory);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern uint RegisterClipboardFormatW(string name);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GlobalAlloc(uint flags,UIntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
    static readonly ManualResetEventSlim Ready=new ManualResetEventSlim();
    static readonly ManualResetEventSlim Rendering=new ManualResetEventSlim();
    static readonly ManualResetEventSlim Released=new ManualResetEventSlim();
    static readonly ManualResetEventSlim Rendered=new ManualResetEventSlim();
    static readonly Procedure Callback=Handle;
    static Thread worker;
    static IntPtr window;
    static string failure;
    static uint format=13;
    public static void ImageFormat(){format=RegisterClipboardFormatW("PNG");if(format==0)throw new Win32Exception();}
    static IntPtr Handle(IntPtr target,uint message,IntPtr parameter,IntPtr data) {
        if(message==0x305 && parameter.ToInt64()==format) {
            Rendering.Set(); Released.Wait();
            IntPtr memory=IntPtr.Zero;
            try {
                byte[] bytes=format==13 ? Encoding.Unicode.GetBytes("delayed clipboard completes after quit timeout\0") : Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==");
                memory=GlobalAlloc(2,(UIntPtr)bytes.Length);
                if(memory==IntPtr.Zero)throw new Win32Exception();
                IntPtr address=GlobalLock(memory);
                if(address==IntPtr.Zero)throw new Win32Exception();
                Marshal.Copy(bytes,0,address,bytes.Length);GlobalUnlock(memory);
                if(SetClipboardData(format,memory)==IntPtr.Zero)throw new Win32Exception();
                memory=IntPtr.Zero;
            }catch(Exception error){failure=error.ToString();}
            finally {if(memory!=IntPtr.Zero)GlobalFree(memory);Rendered.Set();}
            return IntPtr.Zero;
        }
        if(message==0x10){DestroyWindow(target);return IntPtr.Zero;}
        if(message==2){PostQuitMessage(0);return IntPtr.Zero;}
        return DefWindowProcW(target,message,parameter,data);
    }
    public static void Start() {
        worker=new Thread(()=>{
            try {
                string name="DustDeskDelayedClipboard-"+Guid.NewGuid().ToString("N");
                var definition=new WindowClass {Name=name,Instance=GetModuleHandleW(null),Callback=Marshal.GetFunctionPointerForDelegate(Callback)};
                if(RegisterClassW(ref definition)==0)throw new Win32Exception();
                window=CreateWindowExW(0,name,name,0,0,0,0,0,new IntPtr(-3),IntPtr.Zero,definition.Instance,IntPtr.Zero);
                if(window==IntPtr.Zero)throw new Win32Exception();
                long deadline=Environment.TickCount64+5000;
                while(!OpenClipboard(window)){if(Environment.TickCount64>=deadline)throw new Win32Exception();Thread.Sleep(20);}
                try {if(!EmptyClipboard())throw new Win32Exception();SetClipboardData(format,IntPtr.Zero);}finally{CloseClipboard();}
                Ready.Set();Message message;
                while(GetMessageW(out message,IntPtr.Zero,0,0)>0){TranslateMessage(ref message);DispatchMessageW(ref message);}
            }catch(Exception error){failure=error.ToString();Ready.Set();}
        });
        worker.IsBackground=true;worker.SetApartmentState(ApartmentState.STA);worker.Start();
        if(!Ready.Wait(10000))throw new Exception("Delayed clipboard owner startup timed out");
        if(failure!=null)throw new Exception(failure);
    }
    public static bool WaitForRendering(){return Rendering.Wait(10000);}
    public static void Release(){Released.Set();if(!Rendered.Wait(10000))throw new Exception("Delayed rendering did not finish");if(failure!=null)throw new Exception(failure);}
    public static void Stop(){Released.Set();if(window!=IntPtr.Zero)PostMessageW(window,0x10,IntPtr.Zero,IntPtr.Zero);if(worker!=null&&!worker.Join(5000))throw new Exception("Delayed clipboard owner did not stop");if(failure!=null)throw new Exception(failure);}
}
'@
try {
    if($Image){[DustDeskDelayedClipboard]::ImageFormat()}
    [DustDeskDelayedClipboard]::Start()
    [Console]::WriteLine('ready')
    if(-not [DustDeskDelayedClipboard]::WaitForRendering()){throw 'No native reader requested delayed rendering'}
    [Console]::WriteLine('rendering')
    $null=[Console]::ReadLine()
    [DustDeskDelayedClipboard]::Release()
    [Console]::WriteLine('released')
    $null=[Console]::ReadLine()
} finally {
    [DustDeskDelayedClipboard]::Stop()
}
