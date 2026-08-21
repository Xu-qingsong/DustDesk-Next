using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace DustDesk.Next.Services;

public sealed class ShellContextMenuService : IShellContextMenuService
{
    private const uint FirstCommand = 1;
    private const uint LastCommand = 0x7fff;
    private const uint TpmRightButton = 0x0002;
    private const uint TpmReturnCmd = 0x0100;

    public bool ShowForPath(string path)
    {
        if (!File.Exists(path) && !Directory.Exists(path)) return false;
        var owner = OwnerHandle();
        IShellFolder? folder = null; IContextMenu? menuObject = null;
        var absolutePidl = IntPtr.Zero; var pidlArray = IntPtr.Zero; var menu = IntPtr.Zero;
        try
        {
            if (SHParseDisplayName(path, IntPtr.Zero, out absolutePidl, 0, out _) < 0) return false;
            var folderId = typeof(IShellFolder).GUID;
            if (SHBindToParent(absolutePidl, ref folderId, out folder, out var childPidl) < 0 || folder is null) return false;
            pidlArray = Marshal.AllocCoTaskMem(IntPtr.Size); Marshal.WriteIntPtr(pidlArray, childPidl);
            var contextId = typeof(IContextMenu).GUID;
            if (folder.GetUIObjectOf(owner, 1, pidlArray, ref contextId, IntPtr.Zero, out var pointer) < 0 || pointer == IntPtr.Zero) return false;
            menuObject = (IContextMenu)Marshal.GetObjectForIUnknown(pointer); Marshal.Release(pointer);
            menu = CreatePopupMenu();
            if (menu == IntPtr.Zero || menuObject.QueryContextMenu(menu, 0, FirstCommand, LastCommand, 0) < 0) return false;
            GetCursorPos(out var point);
            var command = TrackPopupMenuEx(menu, TpmRightButton | TpmReturnCmd, point.X, point.Y, owner, IntPtr.Zero);
            if (command >= FirstCommand)
            {
                var invoke = new InvokeCommandInfo { Size = Marshal.SizeOf<InvokeCommandInfo>(), Window = owner, Verb = (IntPtr)(command - FirstCommand), Show = 1 };
                menuObject.InvokeCommand(ref invoke);
            }
            return true;
        }
        catch { return false; }
        finally
        {
            if (menu != IntPtr.Zero) DestroyMenu(menu);
            if (menuObject is not null) Marshal.ReleaseComObject(menuObject);
            if (folder is not null) Marshal.ReleaseComObject(folder);
            if (pidlArray != IntPtr.Zero) Marshal.FreeCoTaskMem(pidlArray);
            if (absolutePidl != IntPtr.Zero) CoTaskMemFree(absolutePidl);
        }
    }

    public bool ShowDesktopBackground()
    {
        var owner = OwnerHandle(); IShellFolder? desktop = null; IContextMenu? menuObject = null; var menu = IntPtr.Zero;
        try
        {
            if (SHGetDesktopFolder(out desktop) < 0 || desktop is null) return false;
            var contextId = typeof(IContextMenu).GUID;
            if (desktop.CreateViewObject(owner, ref contextId, out var pointer) < 0 || pointer == IntPtr.Zero) return false;
            menuObject = (IContextMenu)Marshal.GetObjectForIUnknown(pointer); Marshal.Release(pointer);
            menu = CreatePopupMenu(); if (menu == IntPtr.Zero || menuObject.QueryContextMenu(menu, 0, FirstCommand, LastCommand, 0) < 0) return false;
            GetCursorPos(out var point); var command = TrackPopupMenuEx(menu, TpmRightButton | TpmReturnCmd, point.X, point.Y, owner, IntPtr.Zero);
            if (command >= FirstCommand) { var invoke = new InvokeCommandInfo { Size = Marshal.SizeOf<InvokeCommandInfo>(), Window = owner, Verb = (IntPtr)(command - FirstCommand), Show = 1 }; menuObject.InvokeCommand(ref invoke); }
            return true;
        }
        catch { return false; }
        finally { if (menu != IntPtr.Zero) DestroyMenu(menu); if (menuObject is not null) Marshal.ReleaseComObject(menuObject); if (desktop is not null) Marshal.ReleaseComObject(desktop); }
    }

    private static IntPtr OwnerHandle() => Application.Current.MainWindow is { } window ? new WindowInteropHelper(window).Handle : IntPtr.Zero;
    [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)] private struct InvokeCommandInfo { public int Size; public int Mask; public IntPtr Window; public IntPtr Verb; public string? Parameters; public string? Directory; public int Show; public int HotKey; public IntPtr Icon; }
    [ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellFolder
    {
        [PreserveSig] int ParseDisplayName(IntPtr hwnd, IntPtr bind, [MarshalAs(UnmanagedType.LPWStr)] string name, out uint eaten, out IntPtr pidl, ref uint attrs);
        [PreserveSig] int EnumObjects(IntPtr hwnd, int flags, out IntPtr enumerator);
        [PreserveSig] int BindToObject(IntPtr pidl, IntPtr bind, ref Guid id, out IntPtr value);
        [PreserveSig] int BindToStorage(IntPtr pidl, IntPtr bind, ref Guid id, out IntPtr value);
        [PreserveSig] int CompareIDs(IntPtr param, IntPtr left, IntPtr right);
        [PreserveSig] int CreateViewObject(IntPtr owner, ref Guid id, out IntPtr value);
        [PreserveSig] int GetAttributesOf(uint count, IntPtr pidls, ref uint attrs);
        [PreserveSig] int GetUIObjectOf(IntPtr owner, uint count, IntPtr pidls, ref Guid id, IntPtr reserved, out IntPtr value);
        [PreserveSig] int GetDisplayNameOf(IntPtr pidl, uint flags, IntPtr name);
        [PreserveSig] int SetNameOf(IntPtr owner, IntPtr pidl, [MarshalAs(UnmanagedType.LPWStr)] string name, uint flags, out IntPtr output);
    }
    [ComImport, Guid("000214e4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IContextMenu
    {
        [PreserveSig] int QueryContextMenu(IntPtr menu, uint index, uint first, uint last, uint flags);
        [PreserveSig] int InvokeCommand(ref InvokeCommandInfo info);
        [PreserveSig] int GetCommandString(UIntPtr command, uint flags, IntPtr reserved, IntPtr name, uint max);
    }
    [DllImport("shell32.dll")] private static extern int SHGetDesktopFolder(out IShellFolder folder);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern int SHParseDisplayName(string name, IntPtr bind, out IntPtr pidl, uint attrsIn, out uint attrsOut);
    [DllImport("shell32.dll")] private static extern int SHBindToParent(IntPtr pidl, ref Guid id, out IShellFolder folder, out IntPtr child);
    [DllImport("ole32.dll")] private static extern void CoTaskMemFree(IntPtr value);
    [DllImport("user32.dll")] private static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll")] private static extern bool DestroyMenu(IntPtr menu);
    [DllImport("user32.dll")] private static extern uint TrackPopupMenuEx(IntPtr menu, uint flags, int x, int y, IntPtr owner, IntPtr parameters);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out NativePoint point);
}
