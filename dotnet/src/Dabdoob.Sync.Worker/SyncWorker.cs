using Dabdoob.Sync.Application.Abstractions;
using Dabdoob.Sync.Domain.Jobs;

namespace Dabdoob.Sync.Worker;

public sealed class SyncWorker(
    ISyncJobQueue queue,
    ILogger<SyncWorker> logger,
    IConfiguration configuration) : BackgroundService
{
    private readonly string _workerId = $"{Environment.MachineName}:{Environment.ProcessId}:{Guid.NewGuid():N}";
    private readonly TimeSpan _leaseDuration = TimeSpan.FromMinutes(
        configuration.GetValue("Worker:LeaseMinutes", 10));
    private readonly TimeSpan _idleDelay = TimeSpan.FromSeconds(
        configuration.GetValue("Worker:IdleDelaySeconds", 5));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Sync worker {WorkerId} started.", _workerId);

        while (!stoppingToken.IsCancellationRequested)
        {
            SyncJob? job = null;

            try
            {
                job = await queue.ClaimNextAsync(_workerId, _leaseDuration, stoppingToken);

                if (job is null)
                {
                    await Task.Delay(_idleDelay, stoppingToken);
                    continue;
                }

                await ProcessAsync(job, stoppingToken);
                await queue.CompleteAsync(job.Id, stoppingToken);

                logger.LogInformation(
                    "Completed job {JobId} ({JobType}) on attempt {AttemptCount}.",
                    job.Id,
                    job.Type,
                    job.AttemptCount);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                logger.LogError(exception, "Worker failed while processing job {JobId}.", job?.Id);

                if (job is not null)
                {
                    var retryDelay = CalculateRetryDelay(job.AttemptCount);
                    await queue.FailAsync(
                        job.Id,
                        exception.GetType().Name,
                        exception.Message,
                        retryDelay,
                        stoppingToken);
                }
                else
                {
                    await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
                }
            }
        }

        logger.LogInformation("Sync worker {WorkerId} stopped.", _workerId);
    }

    private Task ProcessAsync(SyncJob job, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        return job.Type switch
        {
            SyncJobType.ReconcileSheetRow => ThrowHandlerNotConfigured(job),
            SyncJobType.ReconcileCatalogItem => ThrowHandlerNotConfigured(job),
            SyncJobType.RefreshSource => ThrowHandlerNotConfigured(job),
            SyncJobType.ApplyShopifyMutation => ThrowHandlerNotConfigured(job),
            SyncJobType.RenewGoogleDriveWatch => ThrowHandlerNotConfigured(job),
            _ => throw new ArgumentOutOfRangeException(nameof(job.Type), job.Type, "Unknown job type.")
        };
    }

    private static Task ThrowHandlerNotConfigured(SyncJob job) =>
        throw new InvalidOperationException(
            $"Handler for {job.Type} has not been registered yet. Job remains retryable and auditable.");

    private static TimeSpan CalculateRetryDelay(int attemptCount)
    {
        var exponent = Math.Clamp(attemptCount, 1, 8);
        var minutes = Math.Min(Math.Pow(2, exponent), 360);
        var jitterSeconds = Random.Shared.Next(5, 45);
        return TimeSpan.FromMinutes(minutes).Add(TimeSpan.FromSeconds(jitterSeconds));
    }
}
