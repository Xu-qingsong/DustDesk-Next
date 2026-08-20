using System.Windows.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using DustDesk.Next.Models;

namespace DustDesk.Next.ViewModels;

public partial class WorkdayCountdownViewModel : ObservableObject, IDisposable
{
    private readonly WorkspaceViewModel _workspace;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(1) };
    private bool _normalizingSchedule;

    public WorkdayCountdownViewModel(WorkspaceViewModel workspace)
    {
        _workspace = workspace;
        var settings = workspace.State.Settings;
        _startHour = Math.Clamp(settings.WorkdayStartMinutes / 60, 0, 23);
        _startMinute = Math.Clamp(settings.WorkdayStartMinutes % 60, 0, 59);
        _endHour = Math.Clamp(settings.WorkdayEndMinutes / 60, 0, 23);
        _endMinute = Math.Clamp(settings.WorkdayEndMinutes % 60, 0, 59);
        _monthlySalary = Math.Max(0, settings.MonthlySalary);
        _paydayDay = Math.Clamp(settings.PaydayDay, 1, 31);
        _festivalName = string.IsNullOrWhiteSpace(settings.CountdownFestivalName) ? "目标日" : settings.CountdownFestivalName;
        _festivalDate = WorkdayCountdownCalculator.GetNextAnnualDate(
            DateTime.Today,
            settings.CountdownFestivalMonth,
            settings.CountdownFestivalDay);

        _timer.Tick += (_, _) => Refresh();
        _timer.Start();
        NormalizeSchedule(changedStart: true);
        Refresh();
    }

    public IReadOnlyList<int> Hours { get; } = Enumerable.Range(0, 24).ToArray();
    public IReadOnlyList<int> Minutes { get; } = Enumerable.Range(0, 60).ToArray();
    public IReadOnlyList<int> PaydayDays { get; } = Enumerable.Range(1, 31).ToArray();

    [ObservableProperty] private int _startHour;
    [ObservableProperty] private int _startMinute;
    [ObservableProperty] private int _endHour;
    [ObservableProperty] private int _endMinute;
    [ObservableProperty] private decimal _monthlySalary;
    [ObservableProperty] private int _paydayDay;
    [ObservableProperty] private string _festivalName = string.Empty;
    [ObservableProperty] private DateTime? _festivalDate;

    [ObservableProperty] private string _statusText = string.Empty;
    [ObservableProperty] private string _countdownText = "00:00:00";
    [ObservableProperty] private double _workdayProgressPercent;
    [ObservableProperty] private string _paydayDaysText = "0";
    [ObservableProperty] private string _weekendDaysText = "0";
    [ObservableProperty] private string _festivalDaysText = "0";
    [ObservableProperty] private string _festivalLabel = "目标日";
    [ObservableProperty] private string _todayEarningsText = "¥ 0.00";
    [ObservableProperty] private string _scheduleText = string.Empty;
    [ObservableProperty] private bool _showTodayEarnings;
    [ObservableProperty] private int _metricColumnCount = 3;

    partial void OnStartHourChanged(int value) => NormalizeSchedule(changedStart: true);
    partial void OnStartMinuteChanged(int value) => NormalizeSchedule(changedStart: true);
    partial void OnEndHourChanged(int value) => NormalizeSchedule(changedStart: false);
    partial void OnEndMinuteChanged(int value) => NormalizeSchedule(changedStart: false);

    partial void OnMonthlySalaryChanged(decimal value)
    {
        var normalized = Math.Max(0, value);
        if (normalized != value)
        {
            MonthlySalary = normalized;
            return;
        }
        _workspace.State.Settings.MonthlySalary = normalized;
        SaveAndRefresh();
    }

    partial void OnPaydayDayChanged(int value)
    {
        var normalized = Math.Clamp(value, 1, 31);
        if (normalized != value)
        {
            PaydayDay = normalized;
            return;
        }
        _workspace.State.Settings.PaydayDay = normalized;
        SaveAndRefresh();
    }

    partial void OnFestivalNameChanged(string value)
    {
        _workspace.State.Settings.CountdownFestivalName = string.IsNullOrWhiteSpace(value) ? "目标日" : value.Trim();
        SaveAndRefresh();
    }

    partial void OnFestivalDateChanged(DateTime? value)
    {
        if (value is null) return;
        _workspace.State.Settings.CountdownFestivalMonth = value.Value.Month;
        _workspace.State.Settings.CountdownFestivalDay = value.Value.Day;
        SaveAndRefresh();
    }

    private void NormalizeSchedule(bool changedStart)
    {
        if (_normalizingSchedule) return;
        _normalizingSchedule = true;
        try
        {
            var start = Math.Clamp((StartHour * 60) + StartMinute, 0, (24 * 60) - 2);
            var end = Math.Clamp((EndHour * 60) + EndMinute, 1, (24 * 60) - 1);
            if (end <= start)
            {
                if (changedStart) end = Math.Min((24 * 60) - 1, start + 60);
                else start = Math.Max(0, end - 60);
            }

            SetScheduleFields(start, end);
            _workspace.State.Settings.WorkdayStartMinutes = start;
            _workspace.State.Settings.WorkdayEndMinutes = end;
        }
        finally
        {
            _normalizingSchedule = false;
        }
        SaveAndRefresh();
    }

    private void SetScheduleFields(int start, int end)
    {
        var startHour = start / 60;
        var startMinute = start % 60;
        var endHour = end / 60;
        var endMinute = end % 60;
        StartHour = startHour;
        StartMinute = startMinute;
        EndHour = endHour;
        EndMinute = endMinute;
    }

    private void SaveAndRefresh()
    {
        _workspace.MarkChanged();
        Refresh();
    }

    private void Refresh()
    {
        var snapshot = WorkdayCountdownCalculator.Calculate(DateTime.Now, _workspace.State.Settings);
        StatusText = snapshot.StatusText;
        CountdownText = snapshot.CountdownText;
        WorkdayProgressPercent = snapshot.WorkdayProgressPercent;
        PaydayDaysText = snapshot.PaydayDays.ToString();
        WeekendDaysText = snapshot.WeekendDays.ToString();
        FestivalDaysText = snapshot.FestivalDays.ToString();
        FestivalLabel = snapshot.FestivalName;
        TodayEarningsText = $"¥ {snapshot.TodayEarnings:0.00}";
        ShowTodayEarnings = _workspace.State.Settings.MonthlySalary > 0;
        MetricColumnCount = ShowTodayEarnings ? 4 : 3;
        ScheduleText = $"{StartHour:00}:{StartMinute:00} - {EndHour:00}:{EndMinute:00}";
    }

    public void Dispose() => _timer.Stop();
}
