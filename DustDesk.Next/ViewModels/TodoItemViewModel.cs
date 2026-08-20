using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using DustDesk.Next.Models;

namespace DustDesk.Next.ViewModels;

public partial class TodoItemViewModel : ObservableObject
{
    private bool _updatingReminder;
    public TodoItemViewModel(TodoRecord record)
    {
        Record = record;
        _title = record.Title;
        _tag = record.Tag;
        _note = record.Note;
        _isCompleted = record.IsCompleted;
        _reminderText = record.ReminderAt?.ToString("yyyy-MM-dd HH:mm") ?? string.Empty;
        _reminderDate = record.ReminderAt?.Date;
        _reminderTimeText = record.ReminderAt?.ToString("HH:mm") ?? "09:00";
        _reminderRepeat = record.ReminderRepeat;
    }

    public TodoRecord Record { get; }
    public string Id => Record.Id;
    public DateTime CreatedAt => Record.CreatedAt;
    public string ReminderSummary => Record.ReminderAt is null
        ? "未设置提醒"
        : $"{(Record.ReminderNotifiedAt is null ? "提醒" : "已提醒")} {Record.ReminderAt:MM-dd HH:mm}{RepeatLabel(Record.ReminderRepeat)}";

    [ObservableProperty] private string _title;
    [ObservableProperty] private string _tag;
    [ObservableProperty] private string _note;
    [ObservableProperty] private bool _isCompleted;
    [ObservableProperty] private string _reminderText;
    [ObservableProperty] private DateTime? _reminderDate;
    [ObservableProperty] private string _reminderTimeText;
    [ObservableProperty] private ReminderRepeat _reminderRepeat;
    [ObservableProperty] private string _reminderValidationText = string.Empty;
    [ObservableProperty] private int _tagColorArgb = unchecked((int)0xFF0F8A72);

    partial void OnTitleChanged(string value) => Record.Title = value.Trim();
    partial void OnTagChanged(string value) => Record.Tag = value.Trim();
    partial void OnNoteChanged(string value) => Record.Note = value;
    partial void OnIsCompletedChanged(bool value) => Record.IsCompleted = value;
    partial void OnReminderDateChanged(DateTime? value) { if (!_updatingReminder) ApplyReminderParts(); }
    partial void OnReminderTimeTextChanged(string value) { if (!_updatingReminder) ApplyReminderParts(); }
    partial void OnReminderRepeatChanged(ReminderRepeat value) { Record.ReminderRepeat = value; Record.ReminderNotifiedAt = null; OnPropertyChanged(nameof(ReminderSummary)); }

    partial void OnReminderTextChanged(string value)
    {
        if (_updatingReminder) return;
        if (string.IsNullOrWhiteSpace(value)) { ClearReminder(); return; }
        if (!DateTime.TryParse(value, CultureInfo.CurrentCulture, DateTimeStyles.AllowWhiteSpaces, out var reminder))
        {
            ReminderValidationText = "提醒时间格式无效。";
            return;
        }
        SetReminder(reminder);
    }

    public void SetReminder(DateTime reminder)
    {
        Record.ReminderAt = reminder;
        Record.ReminderNotifiedAt = null;
        _updatingReminder = true;
        ReminderDate = reminder.Date;
        ReminderTimeText = reminder.ToString("HH:mm");
        ReminderText = reminder.ToString("yyyy-MM-dd HH:mm");
        _updatingReminder = false;
        ReminderValidationText = string.Empty;
        OnPropertyChanged(nameof(ReminderSummary));
    }

    public void ClearReminder()
    {
        Record.ReminderAt = null;
        Record.ReminderNotifiedAt = null;
        _updatingReminder = true;
        ReminderDate = null;
        ReminderText = string.Empty;
        _updatingReminder = false;
        ReminderValidationText = string.Empty;
        OnPropertyChanged(nameof(ReminderSummary));
    }

    public void MarkReminderDelivered(DateTime now)
    {
        if (Record.ReminderAt is null) return;
        if (Record.ReminderRepeat == ReminderRepeat.None)
        {
            Record.ReminderNotifiedAt = now;
        }
        else
        {
            var next = Record.ReminderAt.Value;
            do
            {
                next = Record.ReminderRepeat switch
                {
                    ReminderRepeat.Daily => next.AddDays(1),
                    ReminderRepeat.Weekly => next.AddDays(7),
                    ReminderRepeat.Weekdays => NextWeekday(next),
                    _ => next
                };
            } while (next <= now);
            SetReminder(next);
        }
        OnPropertyChanged(nameof(ReminderSummary));
    }

    private void ApplyReminderParts()
    {
        if (ReminderDate is null) { ClearReminder(); return; }
        if (!TimeSpan.TryParse(ReminderTimeText, CultureInfo.CurrentCulture, out var time) || time < TimeSpan.Zero || time >= TimeSpan.FromDays(1))
        {
            ReminderValidationText = "请输入有效时间，例如 09:30。";
            return;
        }
        SetReminder(ReminderDate.Value.Date + time);
    }

    private static DateTime NextWeekday(DateTime value)
    {
        do { value = value.AddDays(1); } while (value.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday);
        return value;
    }

    private static string RepeatLabel(ReminderRepeat repeat) => repeat switch
    {
        ReminderRepeat.Daily => " · 每天",
        ReminderRepeat.Weekdays => " · 工作日",
        ReminderRepeat.Weekly => " · 每周",
        _ => string.Empty
    };

    public static TodoItemViewModel FromRecord(TodoRecord record) => new(record);
}
