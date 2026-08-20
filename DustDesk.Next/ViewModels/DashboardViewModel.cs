using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace DustDesk.Next.ViewModels;

public partial class DashboardViewModel : ObservableObject
{
    public DashboardViewModel(WorkspaceViewModel workspace)
    {
        Workspace = workspace;
        Workspace.PropertyChanged += (_, _) => OnPropertyChanged(string.Empty);
    }

    public WorkspaceViewModel Workspace { get; }
    public IEnumerable<TodoItemViewModel> TodayTodos => Workspace.Todos.Where(item => item.CreatedAt.Date == DateTime.Today);
    public int TodayOpenCount => TodayTodos.Count(item => !item.IsCompleted);
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(AddTodoCommand))]
    private string _newTodoTitle = string.Empty;
    [RelayCommand(CanExecute = nameof(CanAddTodo))]
    private void AddTodo() { Workspace.AddTodo(NewTodoTitle); NewTodoTitle = string.Empty; }
    private bool CanAddTodo() => !string.IsNullOrWhiteSpace(NewTodoTitle);
    public string DateText => DateTime.Now.ToString("M月d日 dddd");
    public string Greeting => DateTime.Now.Hour switch
    {
        < 6 => "夜深了",
        < 11 => "早上好",
        < 14 => "中午好",
        < 18 => "下午好",
        _ => "晚上好"
    };
}
