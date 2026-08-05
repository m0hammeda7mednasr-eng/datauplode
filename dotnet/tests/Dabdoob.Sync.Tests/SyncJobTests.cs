using Dabdoob.Sync.Domain.Jobs;

namespace Dabdoob.Sync.Tests;

public sealed class SyncJobTests
{
    [Fact]
    public void Claim_IncrementsAttemptAndCreatesLease()
    {
        var job = SyncJob.Create(
            SyncJobType.ScanGoogleSheet,
            "sheet:scan:test",
            "{}");

        job.Claim("worker-1", TimeSpan.FromMinutes(5));

        Assert.Equal(SyncJobStatus.Running, job.Status);
        Assert.Equal(1, job.AttemptCount);
        Assert.Equal("worker-1", job.LockedBy);
        Assert.NotNull(job.LockedUntil);
    }

    [Fact]
    public void Fail_SchedulesRetryBeforeMaximumAttempts()
    {
        var job = SyncJob.Create(
            SyncJobType.ReconcileCatalogItem,
            "catalog:test:1",
            "{}",
            maxAttempts: 2);

        job.Claim("worker-1", TimeSpan.FromMinutes(5));
        job.Fail("TEMPORARY", "Temporary failure", TimeSpan.FromMinutes(1));

        Assert.Equal(SyncJobStatus.RetryScheduled, job.Status);
        Assert.Equal("TEMPORARY", job.LastErrorCode);
        Assert.Null(job.LockedBy);
        Assert.Null(job.LockedUntil);
    }

    [Fact]
    public void Fail_MovesToDeadLetterAtMaximumAttempts()
    {
        var job = SyncJob.Create(
            SyncJobType.ReconcileCatalogItem,
            "catalog:test:2",
            "{}",
            maxAttempts: 1);

        job.Claim("worker-1", TimeSpan.FromMinutes(5));
        job.Fail("PERMANENT", "Permanent failure", TimeSpan.FromMinutes(1));

        Assert.Equal(SyncJobStatus.DeadLetter, job.Status);
        Assert.Equal(1, job.AttemptCount);
    }

    [Fact]
    public void Complete_ClearsLeaseAndMarksCompletion()
    {
        var job = SyncJob.Create(
            SyncJobType.ReconcileShopifyOrder,
            "order:test:1",
            "{}");

        job.Claim("worker-1", TimeSpan.FromMinutes(5));
        job.Complete();

        Assert.Equal(SyncJobStatus.Completed, job.Status);
        Assert.NotNull(job.CompletedAt);
        Assert.Null(job.LockedBy);
        Assert.Null(job.LockedUntil);
        Assert.Null(job.LastErrorCode);
    }
}
