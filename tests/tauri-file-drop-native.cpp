#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <ole2.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

static std::wstring absolute_path(const std::wstring& value) {
    std::vector<wchar_t> buffer(32768);
    const auto length = GetFullPathNameW(value.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
    if (length == 0 || length >= buffer.size()) throw std::runtime_error("Absolute path unavailable");
    return std::wstring(buffer.data(), length);
}
static bool within(const std::wstring& value, const std::wstring& root) {
    return value.size() > root.size() && value[root.size()] == L'\\' && _wcsnicmp(value.c_str(), root.c_str(), root.size()) == 0;
}
struct WindowSearch {
    DWORD process;
    std::vector<HWND> matches;
};
static BOOL CALLBACK find_window(HWND window, LPARAM parameter) {
    auto& search = *reinterpret_cast<WindowSearch*>(parameter);
    DWORD process = 0;
    GetWindowThreadProcessId(window, &process);
    wchar_t title[512]{};
    GetWindowTextW(window, title, 512);
    if (process == search.process && IsWindowVisible(window) && std::wstring(title) == L"DustDesk") search.matches.push_back(window);
    return TRUE;
}
class DropData final : public IDataObject {
    std::atomic<ULONG> references{1};
    std::vector<wchar_t> names;
    static FORMATETC format() { return FORMATETC{CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL}; }
public:
    explicit DropData(const std::vector<std::wstring>& paths) {
        for (const auto& path : paths) { names.insert(names.end(), path.begin(), path.end()); names.push_back(0); }
        names.push_back(0);
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID identity, void** output) override {
        if (!output) return E_POINTER;
        *output = nullptr;
        if (identity != IID_IUnknown && identity != IID_IDataObject) return E_NOINTERFACE;
        *output = static_cast<IDataObject*>(this); AddRef(); return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references; }
    ULONG STDMETHODCALLTYPE Release() override { const auto remaining = --references; if (!remaining) delete this; return remaining; }
    HRESULT STDMETHODCALLTYPE GetData(FORMATETC* requested, STGMEDIUM* medium) override {
        std::cerr << "Native OLE data request\n";
        if (!medium) return E_POINTER;
        *medium = {};
        if (QueryGetData(requested) != S_OK) return DV_E_FORMATETC;
        const auto bytes = sizeof(DROPFILES) + names.size() * sizeof(wchar_t);
        const auto memory = GlobalAlloc(GHND, bytes);
        if (!memory) return E_OUTOFMEMORY;
        auto* pointer = static_cast<DROPFILES*>(GlobalLock(memory));
        if (!pointer) { GlobalFree(memory); return E_OUTOFMEMORY; }
        pointer->pFiles = sizeof(DROPFILES); pointer->fWide = TRUE;
        std::memcpy(reinterpret_cast<char*>(pointer) + sizeof(DROPFILES), names.data(), names.size() * sizeof(wchar_t));
        GlobalUnlock(memory);
        medium->tymed = TYMED_HGLOBAL; medium->hGlobal = memory;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetDataHere(FORMATETC*, STGMEDIUM*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE QueryGetData(FORMATETC* requested) override {
        return requested && requested->cfFormat == CF_HDROP && (requested->tymed & TYMED_HGLOBAL) && requested->dwAspect == DVASPECT_CONTENT && requested->lindex == -1 ? S_OK : DV_E_FORMATETC;
    }
    HRESULT STDMETHODCALLTYPE GetCanonicalFormatEtc(FORMATETC*, FORMATETC* output) override { if (!output) return E_POINTER; output->ptd = nullptr; return DATA_S_SAMEFORMATETC; }
    HRESULT STDMETHODCALLTYPE SetData(FORMATETC*, STGMEDIUM*, BOOL) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE EnumFormatEtc(DWORD direction, IEnumFORMATETC** output) override {
        if (direction != DATADIR_GET) return E_NOTIMPL;
        auto available = format(); return SHCreateStdEnumFmtEtc(1, &available, output);
    }
    HRESULT STDMETHODCALLTYPE DAdvise(FORMATETC*, DWORD, IAdviseSink*, DWORD*) override { return OLE_E_ADVISENOTSUPPORTED; }
    HRESULT STDMETHODCALLTYPE DUnadvise(DWORD) override { return OLE_E_ADVISENOTSUPPORTED; }
    HRESULT STDMETHODCALLTYPE EnumDAdvise(IEnumSTATDATA**) override { return OLE_E_ADVISENOTSUPPORTED; }
};
class DropSource final : public IDropSource {
    std::atomic<ULONG> references{1};
    std::chrono::steady_clock::time_point started = std::chrono::steady_clock::now();
    bool cancel;
public:
    std::atomic<unsigned> queries{0};
    explicit DropSource(bool should_cancel) : cancel(should_cancel) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID identity, void** output) override {
        if (!output) return E_POINTER;
        *output = nullptr;
        if (identity != IID_IUnknown && identity != IID_IDropSource) return E_NOINTERFACE;
        *output = static_cast<IDropSource*>(this); AddRef(); return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references; }
    ULONG STDMETHODCALLTYPE Release() override { const auto remaining = --references; if (!remaining) delete this; return remaining; }
    HRESULT STDMETHODCALLTYPE QueryContinueDrag(BOOL escape, DWORD) override {
        if (++queries == 1) std::cerr << "Native OLE source queried\n";
        if (escape) return DRAGDROP_S_CANCEL;
        if (std::chrono::steady_clock::now() - started >= std::chrono::milliseconds(600)) return cancel ? DRAGDROP_S_CANCEL : DRAGDROP_S_DROP;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GiveFeedback(DWORD) override { return DRAGDROP_S_USEDEFAULTCURSORS; }
};
int wmain(int count, wchar_t** arguments) {
    if (count < 7) { std::cerr << "Expected root pid x y action paths"; return 2; }
    POINT original{};
    if (!GetCursorPos(&original)) return 2;
    const auto foreground = GetForegroundWindow();
    const auto awareness = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    bool initialized = false;
    try {
        wchar_t temporary[32768]{};
        if (!GetTempPathW(32768, temporary)) throw std::runtime_error("Temporary root unavailable");
        const auto root = absolute_path(arguments[1]);
        auto temp = absolute_path(temporary); while (!temp.empty() && temp.back() == L'\\') temp.pop_back();
        if (!within(root, temp) || root.substr(root.find_last_of(L'\\') + 1).find(L"dustdesk-tauri-test-") != 0) throw std::runtime_error("Only isolated test roots may be used");
        const auto attributes = GetFileAttributesW(root.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) throw std::runtime_error("Isolated root is invalid");
        std::vector<std::wstring> paths;
        for (int index = 6; index < count; ++index) {
            auto path = absolute_path(arguments[index]);
            if (!within(path, root)) throw std::runtime_error("Only isolated paths may be dragged");
            paths.push_back(path);
        }
        const auto horizontal = std::stod(arguments[3]); const auto vertical = std::stod(arguments[4]);
        const std::wstring action(arguments[5]);
        if (!std::isfinite(horizontal) || !std::isfinite(vertical) || horizontal < 0 || vertical < 0 || (action != L"drop" && action != L"cancel")) throw std::runtime_error("Invalid drop coordinates or action");
        WindowSearch search{static_cast<DWORD>(std::stoul(arguments[2])), {}};
        EnumWindows(find_window, reinterpret_cast<LPARAM>(&search));
        if (search.matches.size() != 1) throw std::runtime_error("Expected exactly one isolated workspace window");
        const auto target = search.matches[0];
        RECT bounds{}; if (!GetClientRect(target, &bounds)) throw std::runtime_error("Client bounds unavailable");
        const auto scale = GetDpiForWindow(target) / 96.0;
        POINT point{static_cast<LONG>(std::round(horizontal * scale)), static_cast<LONG>(std::round(vertical * scale))};
        if (point.x < 0 || point.y < 0 || point.x >= bounds.right || point.y >= bounds.bottom || !ClientToScreen(target, &point)) throw std::runtime_error("Drop must remain inside isolated client area");
        SetForegroundWindow(target);
        if (GetAncestor(WindowFromPoint(point), GA_ROOT) != target) throw std::runtime_error("Isolated target is covered");
        const auto initialization = OleInitialize(nullptr);
        if (FAILED(initialization)) throw std::runtime_error("OLE initialization failed");
        initialized = true;
        const auto source_window = CreateWindowExW(WS_EX_TOOLWINDOW, L"STATIC", L"DustDesk isolated OLE source", WS_POPUP, point.x - 12, point.y, 4, 4, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
        if (!source_window) throw std::runtime_error("Native drag source window unavailable");
        ShowWindow(source_window, SW_SHOW);
        SetForegroundWindow(source_window);
        if (!SetCursorPos(point.x - 10, point.y + 2)) throw std::runtime_error("Native drag source cursor positioning failed: " + std::to_string(GetLastError()));
        SetCapture(source_window);
        auto* data = new DropData(paths); auto* source = new DropSource(action == L"cancel");
        std::atomic<bool> completed{false};
        const auto drag_thread = GetCurrentThreadId();
        std::thread input([&] {
            const auto started = std::chrono::steady_clock::now(); unsigned step = 0;
            while (!completed.load()) {
                if (!SetCursorPos(point.x + static_cast<int>(step++ % 2), point.y)) std::cerr << "Native cursor motion failed: " << GetLastError() << "\n";
                if (!PostThreadMessageW(drag_thread, WM_MOUSEMOVE, MK_LBUTTON, MAKELPARAM(point.x, point.y))) std::cerr << "Native source wake failed: " << GetLastError() << "\n";
                if (std::chrono::steady_clock::now() - started > std::chrono::seconds(10)) {
                    SetCursorPos(original.x, original.y); if (foreground) SetForegroundWindow(foreground);
                    std::cerr << "Native OLE watchdog expired"; ExitProcess(3);
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(40));
            }
        });
        if (!SetCursorPos(point.x, point.y)) std::cerr << "Native initial cursor motion failed: " << GetLastError() << "\n";
        DWORD effect = 0;
        std::cerr << "Native OLE started\n";
        const auto result = DoDragDrop(data, source, DROPEFFECT_COPY, &effect);
        completed.store(true); input.join();
        ReleaseCapture(); DestroyWindow(source_window);
        const auto queries = source->queries.load(); source->Release(); data->Release();
        SetCursorPos(original.x, original.y); if (foreground) SetForegroundWindow(foreground);
        OleUninitialize(); initialized = false; if (awareness) SetThreadDpiAwarenessContext(awareness);
        std::cout << "{\"hresult\":" << result << ",\"effect\":" << effect << ",\"cancelled\":" << (result == DRAGDROP_S_CANCEL ? "true" : "false") << ",\"queries\":" << queries << ",\"scale\":" << scale << "}";
        return result == (action == L"cancel" ? DRAGDROP_S_CANCEL : DRAGDROP_S_DROP) ? 0 : 1;
    } catch (const std::exception& error) {
        SetCursorPos(original.x, original.y); if (foreground) SetForegroundWindow(foreground);
        if (initialized) OleUninitialize(); if (awareness) SetThreadDpiAwarenessContext(awareness);
        std::cerr << error.what(); return 2;
    }
}
