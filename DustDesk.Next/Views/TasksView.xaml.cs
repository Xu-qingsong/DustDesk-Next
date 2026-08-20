using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using DustDesk.Next.ViewModels;

namespace DustDesk.Next.Views;

public partial class TasksView : UserControl
{
    public TasksView()
    {
        InitializeComponent();
    }

    private void AddTodo_OnClick(object sender, RoutedEventArgs e) => OpenEditor(null);

    private void EditTodo_OnClick(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: TodoItemViewModel todo }) OpenEditor(todo);
        e.Handled = true;
    }

    private void TodoList_OnMouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (FindAncestor<ButtonBase>(e.OriginalSource as DependencyObject) is not null) return;
        if (sender is ListBox { SelectedItem: TodoItemViewModel todo }) OpenEditor(todo);
    }

    private static T? FindAncestor<T>(DependencyObject? current) where T : DependencyObject
    {
        while (current is not null)
        {
            if (current is T match) return match;
            current = VisualTreeHelper.GetParent(current);
        }

        return null;
    }

    private void OpenEditor(TodoItemViewModel? todo)
    {
        if (DataContext is not TasksViewModel viewModel) return;

        var dialog = new TaskEditorDialog(
            viewModel.AvailableTags,
            viewModel.ReminderTimes,
            viewModel.ReminderRepeatOptions,
            viewModel.SelectedDate ?? DateTime.Today,
            todo)
        {
            Owner = Window.GetWindow(this)
        };

        if (dialog.ShowDialog() != true) return;
        if (todo is null)
        {
            viewModel.CreateTodo(dialog.TitleValue, dialog.TagValue, dialog.NoteValue, dialog.ReminderAtValue, dialog.ReminderRepeatValue);
        }
        else
        {
            viewModel.UpdateTodo(todo, dialog.TitleValue, dialog.TagValue, dialog.NoteValue, dialog.ReminderAtValue, dialog.ReminderRepeatValue);
        }
    }
}
