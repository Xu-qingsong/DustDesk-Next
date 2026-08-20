using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DustDesk.Next.Models;

namespace DustDesk.Next.ViewModels;

public partial class StatsViewModel : ObservableObject
{
    public StatsViewModel(WorkspaceViewModel workspace) { Workspace = workspace; Refresh(); }
    public WorkspaceViewModel Workspace { get; }
    [ObservableProperty] private int _taskTotal;
    [ObservableProperty] private int _taskCompleted;
    [ObservableProperty] private int _projectTotal;
    [ObservableProperty] private int _phaseTotal;
    [ObservableProperty] private int _desktopCategoryTotal;
    [ObservableProperty] private int _phaseDoing;
    [ObservableProperty] private int _phaseDone;
    [ObservableProperty] private int _noteTotal;
    [ObservableProperty] private int _launcherTotal;
    [ObservableProperty] private int _clipboardTotal;
    public double TaskCompletionPercent => TaskTotal == 0 ? 0 : TaskCompleted * 100d / TaskTotal;
    public double PhaseCompletionPercent => PhaseTotal == 0 ? 0 : PhaseDone * 100d / PhaseTotal;
    [RelayCommand]
    private void Refresh()
    {
        TaskTotal = Workspace.Todos.Count; TaskCompleted = Workspace.Todos.Count(item => item.IsCompleted);
        ProjectTotal = Workspace.State.Projects.Count;
        PhaseTotal = Workspace.State.Projects.SelectMany(item => item.Phases).Count();
        DesktopCategoryTotal = Workspace.State.DesktopCategories.Count;
        PhaseDoing = Workspace.State.Projects.SelectMany(item => item.Phases).Count(item => item.Status == ProjectStatus.Doing);
        PhaseDone = Workspace.State.Projects.SelectMany(item => item.Phases).Count(item => item.Status == ProjectStatus.Done);
        NoteTotal = Workspace.State.Notes.Count; LauncherTotal = Workspace.State.Launchers.Count; ClipboardTotal = Workspace.State.ClipboardHistory.Count;
        OnPropertyChanged(nameof(TaskCompletionPercent)); OnPropertyChanged(nameof(PhaseCompletionPercent));
    }
}
