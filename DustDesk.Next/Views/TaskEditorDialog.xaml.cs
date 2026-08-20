using System.Globalization;
using System.Windows;
using DustDesk.Next.Models;
using DustDesk.Next.ViewModels;

namespace DustDesk.Next.Views;

public partial class TaskEditorDialog : Wpf.Ui.Controls.FluentWindow
{
    private readonly DateTime _taskDate;

    public TaskEditorDialog(
        IEnumerable<string> availableTags,
        IReadOnlyList<string> reminderTimes,
        IReadOnlyList<ReminderRepeatOption> repeatOptions,
        DateTime taskDate,
        TodoItemViewModel? todo = null)
    {
        InitializeComponent();
        _taskDate = taskDate.Date;
        TaskDateText.Text = $"{_taskDate:yyyy年M月d日 dddd}";
        TagBox.ItemsSource = availableTags.ToList();
        ReminderTimeBox.ItemsSource = reminderTimes;
        RepeatBox.ItemsSource = repeatOptions;
        RepeatBox.SelectedValue = ReminderRepeat.None;
        ReminderDatePicker.SelectedDate = _taskDate;
        ReminderTimeBox.Text = "09:00";

        if (todo is null)
        {
            ReminderEnabledBox.IsChecked = false;
            return;
        }

        Title = "编辑任务";
        DialogTitle.Text = "编辑任务";
        SaveButton.Content = "保存修改";
        TitleBox.Text = todo.Title;
        TagBox.Text = todo.Tag;
        NoteBox.Text = todo.Note;
        ReminderEnabledBox.IsChecked = todo.Record.ReminderAt is not null;
        if (todo.Record.ReminderAt is { } reminder)
        {
            ReminderDatePicker.SelectedDate = reminder.Date;
            ReminderTimeBox.Text = reminder.ToString("HH:mm");
        }
        RepeatBox.SelectedValue = todo.ReminderRepeat;
    }

    public string TitleValue => TitleBox.Text.Trim();
    public string TagValue => TagBox.Text.Trim();
    public string NoteValue => NoteBox.Text.Trim();
    public DateTime? ReminderAtValue { get; private set; }
    public ReminderRepeat ReminderRepeatValue { get; private set; }

    private void Window_OnLoaded(object sender, RoutedEventArgs e)
    {
        UpdateReminderFields();
        TitleBox.Focus();
        TitleBox.SelectAll();
    }

    private void ReminderEnabled_OnChanged(object sender, RoutedEventArgs e) => UpdateReminderFields();

    private void UpdateReminderFields()
    {
        if (ReminderFields is not null) ReminderFields.IsEnabled = ReminderEnabledBox.IsChecked == true;
    }

    private void Cancel_OnClick(object sender, RoutedEventArgs e) => DialogResult = false;

    private void Save_OnClick(object sender, RoutedEventArgs e)
    {
        ErrorText.Text = string.Empty;
        if (string.IsNullOrWhiteSpace(TitleValue))
        {
            ErrorText.Text = "请输入任务标题。";
            TitleBox.Focus();
            return;
        }

        ReminderAtValue = null;
        ReminderRepeatValue = ReminderRepeat.None;
        if (ReminderEnabledBox.IsChecked == true)
        {
            if (ReminderDatePicker.SelectedDate is not { } date)
            {
                ErrorText.Text = "请选择提醒日期。";
                ReminderDatePicker.Focus();
                return;
            }

            if (!TimeSpan.TryParse(ReminderTimeBox.Text, CultureInfo.CurrentCulture, out var time) ||
                time < TimeSpan.Zero || time >= TimeSpan.FromDays(1))
            {
                ErrorText.Text = "请输入有效的提醒时间，例如 09:30。";
                ReminderTimeBox.Focus();
                return;
            }

            ReminderAtValue = date.Date + time;
            ReminderRepeatValue = RepeatBox.SelectedValue is ReminderRepeat repeat ? repeat : ReminderRepeat.None;
        }

        DialogResult = true;
    }
}
