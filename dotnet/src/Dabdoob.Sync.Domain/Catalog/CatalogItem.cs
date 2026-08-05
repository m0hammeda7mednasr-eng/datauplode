namespace Dabdoob.Sync.Domain.Catalog;

public enum CatalogSyncStatus
{
    Pending = 0,
    Processing = 1,
    Verified = 2,
    SourceBlocked = 3,
    MissingActiveProduct = 4,
    NeedsReview = 5,
    Failed = 6
}

public sealed class CatalogItem
{
    private CatalogItem()
    {
    }

    public Guid Id { get; private set; } = Guid.NewGuid();
    public string SpreadsheetId { get; private set; } = string.Empty;
    public string SheetName { get; private set; } = string.Empty;
    public int SheetRow { get; private set; }
    public string SourceUrl { get; private set; } = string.Empty;
    public string CanonicalSourceKey { get; private set; } = string.Empty;
    public decimal PriceMultiplier { get; private set; }
    public string CollectionName { get; private set; } = string.Empty;
    public string ExpectedSku { get; private set; } = string.Empty;
    public string? ShopifyProductId { get; private set; }
    public string? ShopifyVariantId { get; private set; }
    public string? SourceFingerprint { get; private set; }
    public CatalogSyncStatus Status { get; private set; } = CatalogSyncStatus.Pending;
    public DateTimeOffset CreatedAt { get; private set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; private set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? LastVerifiedAt { get; private set; }
    public DateTimeOffset? NextCheckAt { get; private set; }
    public string? LastErrorCode { get; private set; }
    public string? LastErrorMessage { get; private set; }

    public static CatalogItem Create(
        string spreadsheetId,
        string sheetName,
        int sheetRow,
        string sourceUrl,
        string canonicalSourceKey,
        decimal priceMultiplier,
        string collectionName,
        string expectedSku)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(spreadsheetId);
        ArgumentException.ThrowIfNullOrWhiteSpace(sheetName);
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceUrl);
        ArgumentException.ThrowIfNullOrWhiteSpace(canonicalSourceKey);
        ArgumentOutOfRangeException.ThrowIfLessThan(sheetRow, 2);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(priceMultiplier);

        return new CatalogItem
        {
            SpreadsheetId = spreadsheetId.Trim(),
            SheetName = sheetName.Trim(),
            SheetRow = sheetRow,
            SourceUrl = sourceUrl.Trim(),
            CanonicalSourceKey = canonicalSourceKey.Trim(),
            PriceMultiplier = priceMultiplier,
            CollectionName = collectionName.Trim(),
            ExpectedSku = expectedSku.Trim()
        };
    }

    public void MarkProcessing()
    {
        Status = CatalogSyncStatus.Processing;
        Touch();
    }

    public void MarkVerified(
        string shopifyProductId,
        string shopifyVariantId,
        string sourceFingerprint,
        DateTimeOffset nextCheckAt)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(shopifyProductId);
        ArgumentException.ThrowIfNullOrWhiteSpace(shopifyVariantId);
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceFingerprint);

        ShopifyProductId = shopifyProductId;
        ShopifyVariantId = shopifyVariantId;
        SourceFingerprint = sourceFingerprint;
        Status = CatalogSyncStatus.Verified;
        LastVerifiedAt = DateTimeOffset.UtcNow;
        NextCheckAt = nextCheckAt;
        LastErrorCode = null;
        LastErrorMessage = null;
        Touch();
    }

    public void MarkBlocked(string errorCode, string message, DateTimeOffset retryAt)
    {
        Status = CatalogSyncStatus.SourceBlocked;
        LastErrorCode = errorCode;
        LastErrorMessage = message;
        NextCheckAt = retryAt;
        Touch();
    }

    public void MarkNeedsReview(CatalogSyncStatus status, string errorCode, string message)
    {
        if (status is CatalogSyncStatus.Pending or CatalogSyncStatus.Processing or CatalogSyncStatus.Verified)
        {
            throw new ArgumentOutOfRangeException(nameof(status), status, "A review status is required.");
        }

        Status = status;
        LastErrorCode = errorCode;
        LastErrorMessage = message;
        Touch();
    }

    private void Touch() => UpdatedAt = DateTimeOffset.UtcNow;
}
