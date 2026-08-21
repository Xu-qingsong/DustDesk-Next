namespace DustDesk.Next.Services;

public interface IWidgetManager
{
    bool IsVisible(string key);
    void Show(string key);
    void Hide(string key);
    void Toggle(string key);
    void ToggleConfigured();
    void RestoreConfigured();
    void CloseAll(bool preserveVisibility);
    void RefreshAppearance();
    IReadOnlyList<string> GetLayoutPresetNames() => Array.Empty<string>();
    void SaveLayoutPreset(string name) => throw new NotSupportedException();
    bool ApplyLayoutPreset(string name) => false;
    bool DeleteLayoutPreset(string name) => false;
}
