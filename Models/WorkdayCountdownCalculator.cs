namespace DustDesk.Next.Models;

public static class WorkdayCountdownCalculator
{
    public static WorkdayCountdownSnapshot Calculate(DateTime now, AppSettings settings)
    {
        var date = now.Date;
        var startMinutes = Math.Clamp(settings.WorkdayStartMinutes, 0, (24 * 60) - 2);
        var start = date.AddMinutes(startMinutes);
        var end = date.AddMinutes(Math.Clamp(settings.WorkdayEndMinutes, startMinutes + 1, (24 * 60) - 1));
        var isWorkday = IsWorkday(date);

        string statusText;
        TimeSpan remaining;
        double progress;
        decimal todayEarnings;

        if (!isWorkday)
        {
            statusText = "距离上班";
            remaining = FindNextWorkday(date).Add(start.TimeOfDay) - now;
            progress = 0;
            todayEarnings = 0;
        }
        else if (now < start)
        {
            statusText = "距离上班";
            remaining = start - now;
            progress = 0;
            todayEarnings = 0;
        }
        else if (now < end)
        {
            statusText = "下班还有";
            remaining = end - now;
            progress = Math.Clamp((now - start).TotalSeconds / (end - start).TotalSeconds * 100, 0, 100);
            todayEarnings = CalculateDailyEarnings(now, settings) * (decimal)(progress / 100d);
        }
        else
        {
            statusText = "今天已收工";
            remaining = TimeSpan.Zero;
            progress = 100;
            todayEarnings = CalculateDailyEarnings(now, settings);
        }

        var festivalDate = GetNextAnnualDate(date, settings.CountdownFestivalMonth, settings.CountdownFestivalDay);
        return new WorkdayCountdownSnapshot(
            statusText,
            FormatDuration(remaining),
            progress,
            (GetNextPayday(date, settings.PaydayDay) - date).Days,
            DaysUntilWeekend(date),
            (festivalDate - date).Days,
            string.IsNullOrWhiteSpace(settings.CountdownFestivalName) ? "目标日" : settings.CountdownFestivalName.Trim(),
            decimal.Round(todayEarnings, 2, MidpointRounding.AwayFromZero));
    }

    public static DateTime GetNextAnnualDate(DateTime fromDate, int month, int day)
    {
        month = Math.Clamp(month, 1, 12);
        var current = CreateClampedDate(fromDate.Year, month, day);
        return current < fromDate.Date ? CreateClampedDate(fromDate.Year + 1, month, day) : current;
    }

    private static decimal CalculateDailyEarnings(DateTime now, AppSettings settings)
    {
        if (settings.MonthlySalary <= 0) return 0;
        var workdays = Enumerable.Range(1, DateTime.DaysInMonth(now.Year, now.Month))
            .Count(day => IsWorkday(new DateTime(now.Year, now.Month, day)));
        return workdays == 0 ? 0 : settings.MonthlySalary / workdays;
    }

    private static DateTime GetNextPayday(DateTime date, int paydayDay)
    {
        var current = CreateClampedDate(date.Year, date.Month, paydayDay);
        if (current >= date) return current;
        var nextMonth = date.AddMonths(1);
        return CreateClampedDate(nextMonth.Year, nextMonth.Month, paydayDay);
    }

    private static int DaysUntilWeekend(DateTime date)
    {
        if (date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) return 0;
        return (int)DayOfWeek.Saturday - (int)date.DayOfWeek;
    }

    private static DateTime FindNextWorkday(DateTime date)
    {
        do date = date.AddDays(1); while (!IsWorkday(date));
        return date;
    }

    private static bool IsWorkday(DateTime date) => date.DayOfWeek is not DayOfWeek.Saturday and not DayOfWeek.Sunday;

    private static DateTime CreateClampedDate(int year, int month, int day) =>
        new(year, month, Math.Clamp(day, 1, DateTime.DaysInMonth(year, month)));

    private static string FormatDuration(TimeSpan value)
    {
        value = value < TimeSpan.Zero ? TimeSpan.Zero : value;
        return $"{(int)value.TotalHours:00}:{value.Minutes:00}:{value.Seconds:00}";
    }
}

public sealed record WorkdayCountdownSnapshot(
    string StatusText,
    string CountdownText,
    double WorkdayProgressPercent,
    int PaydayDays,
    int WeekendDays,
    int FestivalDays,
    string FestivalName,
    decimal TodayEarnings);
