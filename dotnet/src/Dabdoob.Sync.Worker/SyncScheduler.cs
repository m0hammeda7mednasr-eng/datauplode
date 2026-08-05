using Dabdoob.Sync.Application.Abstractions;
using Dabdoob.Sync.Domain.Jobs;

namespace Dabdoob.Sync.Worker;

public sealed class SyncScheduler(
    ISyncJobQueue queue,
    IConfiguration configuration,
    ILogger<SyncScheduler> logger) : BackgroundService
{
    private readonly TimeSpan _sheetScanInterval = TimeSpan.FromMinutes(
        Math.Max(configuration.GetValue("Sync:FallbackPollMinutes", 15), 5));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation(
            "Sync scheduler started with Google Sheet fallback interval {Interval}.",
            _sheetScanInterval);

        await EnqueueSheetScanAsync(stoppingToken);

        using var timer = new PeriodicTimer(_sheetScanInterval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await EnqueueSheetScanAsync(stoppingToken);
        }
    }

    private async Task EnqueueSheetScanAsync(CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var bucket = now.UtcTicks / _sheetScanInterval.Ticks;
        var idempotencyKey = $"scheduled-sheet-scan:{bucket}";

        var created = await queue.EnqueueAsync(
            SyncJobType.ScanGoogleSheet,
            idempotencyKey,
            "{}",
            null,
            cancellationToken);

        logger.LogInformation(
            created
                ? "Queued fallback Google Sheet scan {IdempotencyKey}."
                : "Fallback Google Sheet scan {IdempotencyKey} already exists.",
            idempotencyKey);
    }
}
