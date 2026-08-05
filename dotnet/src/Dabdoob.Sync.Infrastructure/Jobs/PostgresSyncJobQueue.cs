using System.Data;
using Dabdoob.Sync.Application.Abstractions;
using Dabdoob.Sync.Domain.Jobs;
using Dabdoob.Sync.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Dabdoob.Sync.Infrastructure.Jobs;

public sealed class PostgresSyncJobQueue(IDbContextFactory<SyncDbContext> dbContextFactory) : ISyncJobQueue
{
    public async Task<bool> EnqueueAsync(
        SyncJobType type,
        string idempotencyKey,
        string payloadJson,
        DateTimeOffset? availableAt,
        CancellationToken cancellationToken)
    {
        await using var db = await dbContextFactory.CreateDbContextAsync(cancellationToken);
        db.SyncJobs.Add(SyncJob.Create(type, idempotencyKey, payloadJson, availableAt));

        try
        {
            await db.SaveChangesAsync(cancellationToken);
            return true;
        }
        catch (DbUpdateException exception)
            when (exception.InnerException is PostgresException
            {
                SqlState: PostgresErrorCodes.UniqueViolation
            })
        {
            return false;
        }
    }

    public async Task<SyncJob?> ClaimNextAsync(
        string workerId,
        TimeSpan leaseDuration,
        CancellationToken cancellationToken)
    {
        await using var db = await dbContextFactory.CreateDbContextAsync(cancellationToken);
        await using var transaction = await db.Database.BeginTransactionAsync(
            IsolationLevel.ReadCommitted,
            cancellationToken);

        var job = await db.SyncJobs
            .FromSqlRaw(
                """
                SELECT *
                FROM sync_jobs
                WHERE "Status" IN (0, 3)
                  AND "AvailableAt" <= NOW()
                  AND ("LockedUntil" IS NULL OR "LockedUntil" < NOW())
                ORDER BY "AvailableAt", "CreatedAt"
                FOR UPDATE SKIP LOCKED
                LIMIT 1
                """)
            .AsTracking()
            .SingleOrDefaultAsync(cancellationToken);

        if (job is null)
        {
            await transaction.CommitAsync(cancellationToken);
            return null;
        }

        job.Claim(workerId, leaseDuration);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return job;
    }

    public async Task CompleteAsync(Guid jobId, CancellationToken cancellationToken)
    {
        await using var db = await dbContextFactory.CreateDbContextAsync(cancellationToken);
        var job = await db.SyncJobs.SingleAsync(x => x.Id == jobId, cancellationToken);
        job.Complete();
        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task FailAsync(
        Guid jobId,
        string errorCode,
        string message,
        TimeSpan retryDelay,
        CancellationToken cancellationToken)
    {
        await using var db = await dbContextFactory.CreateDbContextAsync(cancellationToken);
        var job = await db.SyncJobs.SingleAsync(x => x.Id == jobId, cancellationToken);
        job.Fail(errorCode, message, retryDelay);
        await db.SaveChangesAsync(cancellationToken);
    }
}
