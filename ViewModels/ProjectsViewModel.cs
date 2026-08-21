using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.ComponentModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DustDesk.Next.Models;
using DustDesk.Next.Services;

namespace DustDesk.Next.ViewModels;

public partial class ProjectsViewModel : ObservableObject
{
    private readonly IDesktopService _desktop;
    private readonly IWidgetManager _widgets;
    private readonly TasksViewModel? _tasks;

    public ProjectsViewModel(WorkspaceViewModel workspace, IDesktopService desktop, IWidgetManager widgets, TasksViewModel? tasks = null)
    {
        Workspace = workspace;
        _desktop = desktop; _tasks = tasks;
        _widgets = widgets;
        foreach (var record in workspace.State.Projects)
        {
            AddWrappedProject(record);
        }
        SelectedProject = Projects.FirstOrDefault();
    }

    public WorkspaceViewModel Workspace { get; }
    public ObservableCollection<ProjectItemViewModel> Projects { get; } = new();

    [ObservableProperty] private ProjectItemViewModel? _selectedProject;
    [ObservableProperty] private ProjectPhaseViewModel? _selectedPhase;
    [ObservableProperty] private string _newProjectName = string.Empty;
    [ObservableProperty] private string _newPhaseTitle = string.Empty;
    [ObservableProperty] private string _newSubtaskTitle = string.Empty;

    partial void OnSelectedProjectChanged(ProjectItemViewModel? value) => SelectedPhase = value?.Phases.FirstOrDefault();

    [RelayCommand]
    private void AddProject()
    {
        if (string.IsNullOrWhiteSpace(NewProjectName)) return;
        var record = new ProjectRecord { Name = NewProjectName.Trim() };
        Workspace.State.Projects.Add(record);
        SelectedProject = AddWrappedProject(record);
        NewProjectName = string.Empty;
        Workspace.MarkChanged();
    }

    [RelayCommand]
    private void DeleteProject(ProjectItemViewModel? project)
    {
        if (project is null) return;
        if (!ConfirmationDialog.ConfirmDelete("这个项目")) return;
        var widgetKey = $"project:{project.Record.Id}";
        _widgets.Hide(widgetKey); Workspace.State.Settings.WidgetPlacements.Remove(widgetKey);
        Projects.Remove(project);
        Workspace.State.Projects.Remove(project.Record);
        SelectedProject = Projects.FirstOrDefault();
        Workspace.MarkChanged();
    }

    [RelayCommand]
    private void AddPhase()
    {
        if (SelectedProject is null || string.IsNullOrWhiteSpace(NewPhaseTitle)) return;
        var record = new ProjectPhaseRecord { Title = NewPhaseTitle.Trim() };
        SelectedProject.Record.Phases.Add(record);
        var item = new ProjectPhaseViewModel(record);
        ObservePhase(item);
        SelectedProject.Phases.Add(item);
        SelectedPhase = item;
        NewPhaseTitle = string.Empty;
        Workspace.MarkChanged();
    }

    [RelayCommand]
    private void DeletePhase(ProjectPhaseViewModel? phase)
    {
        if (SelectedProject is null || phase is null) return;
        if (!ConfirmationDialog.ConfirmDelete("这个阶段")) return;
        SelectedProject.Phases.Remove(phase);
        SelectedProject.Record.Phases.Remove(phase.Record);
        SelectedPhase = SelectedProject.Phases.FirstOrDefault();
        Workspace.MarkChanged();
    }

    [RelayCommand]
    private void CreateTaskFromPhase(ProjectPhaseViewModel? phase)
    {
        if (phase is null || string.IsNullOrWhiteSpace(phase.Title)) return;
        _tasks?.CreateFromText(phase.Title);
    }

    [RelayCommand]
    private void CreateTaskFromSubtask(ProjectSubtaskViewModel? subtask)
    {
        if (subtask is null || string.IsNullOrWhiteSpace(subtask.Title)) return;
        _tasks?.CreateFromText(subtask.Title);
    }

    [RelayCommand]
    private void AddSubtask()
    {
        if (SelectedPhase is null || string.IsNullOrWhiteSpace(NewSubtaskTitle)) return;
        var record = new ProjectSubtaskRecord { Title = NewSubtaskTitle.Trim() };
        SelectedPhase.Record.Subtasks.Add(record);
        var item = new ProjectSubtaskViewModel(record);
        item.PropertyChanged += OnNestedChanged;
        SelectedPhase.Subtasks.Add(item);
        NewSubtaskTitle = string.Empty;
        Workspace.MarkChanged();
    }

    [RelayCommand]
    private void DeleteSubtask(ProjectSubtaskViewModel? subtask)
    {
        if (SelectedPhase is null || subtask is null) return;
        if (!ConfirmationDialog.ConfirmDelete("这个子事项")) return;
        SelectedPhase.Subtasks.Remove(subtask);
        SelectedPhase.Record.Subtasks.Remove(subtask.Record);
        Workspace.MarkChanged();
    }

    [RelayCommand]
    private void ChooseProjectPath()
    {
        if (SelectedProject is null) return;
        var path = _desktop.PickFolder("选择项目路径");
        if (path is not null) SelectedProject.ProjectPath = path;
    }

    [RelayCommand]
    private void OpenProjectPath() { if (SelectedProject is not null) _desktop.Open(SelectedProject.ProjectPath); }

    [RelayCommand]
    private void ChoosePhasePath()
    {
        if (SelectedPhase is null) return;
        var path = _desktop.PickFolder("选择阶段路径");
        if (path is not null) SelectedPhase.ProjectPath = path;
    }

    [RelayCommand]
    private void OpenPhasePath() { if (SelectedPhase is not null) _desktop.Open(SelectedPhase.ProjectPath); }

    [RelayCommand]
    private void ChooseSubtaskFile(ProjectSubtaskViewModel? subtask)
    {
        if (subtask is null) return;
        var path = _desktop.PickFileOrFolder("选择子事项关联路径");
        if (path is not null) subtask.FilePath = path;
    }

    [RelayCommand]
    private void OpenSubtaskFile(ProjectSubtaskViewModel? subtask) { if (subtask is not null) _desktop.Open(subtask.FilePath); }

    [RelayCommand]
    private void PinSelectedProject() { if (SelectedProject is not null) _widgets.Show($"project:{SelectedProject.Record.Id}"); }

    public void SelectItem(string id)
    {
        foreach (var project in Projects)
        {
            if (string.Equals(project.Record.Id, id, StringComparison.OrdinalIgnoreCase))
            {
                SelectedProject = project;
                return;
            }

            foreach (var phase in project.Phases)
            {
                if (!string.Equals(phase.Record.Id, id, StringComparison.OrdinalIgnoreCase) &&
                    phase.Subtasks.All(subtask => !string.Equals(subtask.Record.Id, id, StringComparison.OrdinalIgnoreCase)))
                {
                    continue;
                }

                SelectedProject = project;
                SelectedPhase = phase;
                return;
            }
        }
    }

    private ProjectItemViewModel AddWrappedProject(ProjectRecord record)
    {
        var project = new ProjectItemViewModel(record);
        project.PropertyChanged += OnNestedChanged;
        project.Phases.CollectionChanged += OnPhasesChanged;
        foreach (var phase in project.Phases) ObservePhase(phase);
        Projects.Add(project);
        return project;
    }

    private void ObservePhase(ProjectPhaseViewModel phase)
    {
        phase.PropertyChanged += OnNestedChanged;
        phase.Subtasks.CollectionChanged += OnSubtasksChanged;
        foreach (var subtask in phase.Subtasks) subtask.PropertyChanged += OnNestedChanged;
    }

    private void OnPhasesChanged(object? sender, NotifyCollectionChangedEventArgs e) => Workspace.MarkChanged();
    private void OnSubtasksChanged(object? sender, NotifyCollectionChangedEventArgs e) => Workspace.MarkChanged();
    private void OnNestedChanged(object? sender, PropertyChangedEventArgs e) => Workspace.MarkChanged();
}
