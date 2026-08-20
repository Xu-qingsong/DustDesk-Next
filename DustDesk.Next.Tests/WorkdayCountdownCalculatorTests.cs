using DustDesk.Next.Models;
using DustDesk.Next.Services;
using DustDesk.Next.ViewModels;
using Xunit;

namespace DustDesk.Next.Tests;

public sealed class WorkdayCountdownCalculatorTests
{
    [Fact]
    public void WorkingDayCalculatesCountdownMilestonesAndAccruedSalary()
    {
        var settings = CreateSettings();

        var result = WorkdayCountdownCalculator.Calculate(new DateTime(2026, 7, 22, 12, 0, 0), settings);

        Assert.Equal("下班还有", result.StatusText);
        Assert.Equal("06:00:00", result.CountdownText);
        Assert.Equal(100d / 3, result.WorkdayProgressPercent, 5);
        Assert.Equal(3, result.PaydayDays);
        Assert.Equal(3, result.WeekendDays);
        Assert.Equal(10, result.FestivalDays);
        Assert.Equal("建军节", result.FestivalName);
        Assert.Equal(333.33m, result.TodayEarnings);
    }

    [Fact]
    public void WeekendCountsDownToNextWorkingDayWithoutSalary()
    {
        var settings = CreateSettings();

        var result = WorkdayCountdownCalculator.Calculate(new DateTime(2026, 7, 26, 12, 0, 0), settings);

        Assert.Equal("距离上班", result.StatusText);
        Assert.Equal("21:00:00", result.CountdownText);
        Assert.Equal(0, result.WeekendDays);
        Assert.Equal(0m, result.TodayEarnings);
    }

    [Fact]
    public void AnnualDateAndPaydayRollForward()
    {
        var settings = CreateSettings();
        settings.PaydayDay = 31;
        settings.CountdownFestivalMonth = 1;
        settings.CountdownFestivalDay = 1;

        var result = WorkdayCountdownCalculator.Calculate(new DateTime(2026, 2, 28, 19, 0, 0), settings);

        Assert.Equal(0, result.PaydayDays);
        Assert.Equal(307, result.FestivalDays);
    }

    [Fact]
    public async Task TodayEarningsMetricIsHiddenWhenSalaryIsZero()
    {
        var state = WorkspaceDefaults.Create(includeStarterTodos: false, legacyImportCompleted: true);
        state.Settings.MonthlySalary = 0;
        var workspace = new WorkspaceViewModel(new MemoryStateStore(state), new NoLegacyImporter());
        await workspace.InitializeAsync();
        using var viewModel = new WorkdayCountdownViewModel(workspace);

        Assert.False(viewModel.ShowTodayEarnings);
        Assert.Equal(3, viewModel.MetricColumnCount);

        viewModel.MonthlySalary = 15000;

        Assert.True(viewModel.ShowTodayEarnings);
        Assert.Equal(4, viewModel.MetricColumnCount);
        Assert.Equal("09:00 - 18:00", viewModel.ScheduleText);
    }

    private static AppSettings CreateSettings() => new()
    {
        WorkdayStartMinutes = 9 * 60,
        WorkdayEndMinutes = 18 * 60,
        MonthlySalary = 23000,
        PaydayDay = 25,
        CountdownFestivalName = "建军节",
        CountdownFestivalMonth = 8,
        CountdownFestivalDay = 1
    };

    private sealed class MemoryStateStore(WorkspaceState state) : IAppStateStore
    {
        public string DataFilePath => "memory://workspace.json";
        public string DataDirectory => "memory://";
        public Task<WorkspaceState> LoadAsync(CancellationToken cancellationToken = default) => Task.FromResult(state);
        public Task SaveAsync(WorkspaceState value, CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private sealed class NoLegacyImporter : ILegacyDataImporter
    {
        public Task<bool> ImportAsync(WorkspaceState target, CancellationToken cancellationToken = default) => Task.FromResult(false);
    }
}
