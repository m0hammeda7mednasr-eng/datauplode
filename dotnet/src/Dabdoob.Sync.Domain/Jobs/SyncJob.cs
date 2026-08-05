namespace Dabdoob.Sync.Domain.Jobs;

public enum SyncJobType
{
    ReconcileSheetRow = 0,
    ReconcileCatalogItem = 1,
    RefreshSource = 2,
    ApplyShopifyMutation = 3,
    RenewGoogleDriveWatch = 4
}

public enum SyncJobStatus
{
    Pending = 0,
    Running = 1,
    Completed = 2,
    RetryScheduled = 3,
    DeadLetter = 4,
    Cancelled = 5
}

public sealed class SyncJob
{
    private SyncJob()
    {
    }

    public Guid Id { get; private set; } = Guid.NewGuid();
    public SyncJobType Type { get; private set; }
    public SyncJobStatus Status { get; private set; } = SyncJobStatus.Pending;
    public string IdempotencyKey { get; private set; } = string.Empty;
    public string PayloadJson { get; private set; } = "{}";
    public int AttemptCount { get; private set; }
    public int MaxAttempts { get; private set; } = 8;
    public DateTimeOffset AvailableAt { get; private set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? LockedUntil { get; private set; }
    public string? LockedBy { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; private set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? CompletedAt { get; private set; }
    public string? LastErrorCode { get; private set; }
    public string? LastErrorMessage { get; private set; }

    public static SyncJob Create(
        SyncJobType type,
        string idempotencyKey,
        string payloadJson,
        DateTimeOffset? availableAt = null,
        int maxAttempts = 8)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(idempotencyKey);
        ArgumentException.ThrowIfNullOrWhiteSpace(payloadJson);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxAttempts, 1);

        return new SyncJob
        {
            Type = type,
            IdempotencyKey = idempotencyKey.Trim(),
            PayloadJson = payloadJson,
            AvailableAt = availableAt ?? DateTimeOffset.UtcNow,
            MaxAttempts = maxAttempts
        };
    }

    public void Claim(string workerId, TimeSpan leaseDuration)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(workerId);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(leaseDuration, TimeSpan.Zero);

        Status = SyncJobStatus.Running;
        LockedBy = workerId;
        LockedUntil = DateTimeOffset.UtcNow.Add(leaseDuration);
        AttemptCount++;
        UpdatedAt = DateTimeOffset.UtcNow;
    }

    public void Complete()
    {
        Status = SyncJobStatus.Completed;
        LockedBy = null;
        LockedUntil = null;
        LastErrorCode = null;
        LastErrorMessage = null;
        CompletedAt = DateTimeOffset.UtcNow;
        UpdatedAt = DateTimeOffset.UtcNow;
    }

    public void Fail(string errorCode, string message, TimeSpan retryDelay)
    {
        LastErrorCode = errorCode;
        LastErrorMessage = message;
        LockedBy = null;
        LockedUntil = null;
        UpdatedAt = DateTimeOffset.UtcNow;

        if (AttemptCount >= MaxAttempts)
        {
            Status = SyncJobStatus.DeadLetter;
            return;
        }

        Status = SyncJobStatus.RetryScheduled;
        AvailableAt = DateTimeOffset.UtcNow.Add(retryDelay);
    }
}
