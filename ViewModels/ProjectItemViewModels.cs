using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Collections.Specialized;
using CommunityToolkit.Mvvm.ComponentModel;
using DustDesk.Next.Models;

namespace DustDesk.Next.ViewModels;

public partial class ProjectSubtaskViewModel : ObservableObject
{
    public ProjectSubtaskViewModel(ProjectSubtaskRecord record)
    {
        Record = record;
        _title = record.Title;
        _isCompleted = record.IsCompleted;
        _filePath = record.FilePath;
    }

    public ProjectSubtaskRecord Record { get; }
    [ObservableProperty] private string _title;
    [ObservableProperty] private bool _isCompleted;
    [ObservableProperty] private string _filePath;
    partial void OnTitleChanged(string value) => Record.Title = value.Trim();
    partial void OnIsCompletedChanged(bool value) => Record.IsCompleted = value;
    partial void OnFilePathChanged(string value) => Record.FilePath = value;
}

public partial class ProjectPhaseViewModel : ObservableObject
{
    public ProjectPhaseViewModel(ProjectPhaseRecord record)
    {
        Record = record;
        _title = record.Title;
        _status = record.Status;
        _startDate = record.StartDate;
        _endDate = record.EndDate;
        _progressPercent = record.ProgressPercent;
        _projectPath = record.ProjectPath;
        foreach (var subtask in record.Subtasks)
        {
            var item = new ProjectSubtaskViewModel(subtask);
            item.PropertyChanged += OnSubtaskChanged;
            Subtasks.Add(item);
        }
        Subtasks.CollectionChanged += OnSubtasksChanged;
    }

    public ProjectPhaseRecord Record { get; }
    public ObservableCollection<ProjectSubtaskViewModel> Subtasks { get; } = new();
    public Array StatusValues => Enum.GetValues(typeof(ProjectStatus));
    public int CalculatedProgress => ProgressPercent >= 0
        ? Math.Clamp(ProgressPercent, 0, 100)
        : Subtasks.Count > 0
            ? (int)Math.Round(Subtasks.Count(item => item.IsCompleted) * 100d / Subtasks.Count)
            : Status switch { ProjectStatus.Done => 100, ProjectStatus.Doing => 50, _ => 0 };

    [ObservableProperty] private string _title;
    [ObservableProperty] private ProjectStatus _status;
    [ObservableProperty] private DateTime? _startDate;
    [ObservableProperty] private DateTime? _endDate;
    [ObservableProperty] private int _progressPercent;
    [ObservableProperty] private string _projectPath;

    partial void OnTitleChanged(string value) => Record.Title = value.Trim();
    partial void OnStatusChanged(ProjectStatus value) { Record.Status = value; OnPropertyChanged(nameof(CalculatedProgress)); }
    partial void OnStartDateChanged(DateTime? value) => Record.StartDate = value;
    partial void OnEndDateChanged(DateTime? value) => Record.EndDate = value;
    partial void OnProgressPercentChanged(int value) { Record.ProgressPercent = value; OnPropertyChanged(nameof(CalculatedProgress)); }
    partial void OnProjectPathChanged(string value) => Record.ProjectPath = value;
    private void OnSubtaskChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(ProjectSubtaskViewModel.IsCompleted)) OnPropertyChanged(nameof(CalculatedProgress));
    }
    private void OnSubtasksChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        if (e.OldItems is not null) foreach (ProjectSubtaskViewModel item in e.OldItems) item.PropertyChanged -= OnSubtaskChanged;
        if (e.NewItems is not null) foreach (ProjectSubtaskViewModel item in e.NewItems) item.PropertyChanged += OnSubtaskChanged;
        OnPropertyChanged(nameof(CalculatedProgress));
    }
}

public partial class ProjectItemViewModel : ObservableObject
{
    public ProjectItemViewModel(ProjectRecord record)
    {
        Record = record;
        _name = record.Name;
        _projectPath = record.ProjectPath;
        foreach (var phase in record.Phases)
        {
            Phases.Add(new ProjectPhaseViewModel(phase));
        }
    }

    public ProjectRecord Record { get; }
    public ObservableCollection<ProjectPhaseViewModel> Phases { get; } = new();
    [ObservableProperty] private string _name;
    [ObservableProperty] private string _projectPath;
    partial void OnNameChanged(string value) => Record.Name = value.Trim();
    partial void OnProjectPathChanged(string value) => Record.ProjectPath = value;
}
