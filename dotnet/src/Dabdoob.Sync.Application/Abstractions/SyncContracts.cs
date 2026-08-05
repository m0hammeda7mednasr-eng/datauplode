using Dabdoob.Sync.Domain.Jobs;

namespace Dabdoob.Sync.Application.Abstractions;

public sealed record SheetProductRow(
    string SpreadsheetId,
    string SheetName,
    int RowNumber,
    string SourceUrl,
    decimal PriceMultiplier,
    string CollectionName,
    string ExpectedSku);

public sealed record SourceVariantSnapshot(
    string SourceVariantKey,
    string Title,
    string? Color,
    string? Size,
    decimal Price,
    string Currency,
    bool IsAvailable);

public sealed record SourceProductSnapshot(
    string CanonicalSourceKey,
    string ProductTitle,
    string SourceFingerprint,
    IReadOnlyList<SourceVariantSnapshot> Variants,
    DateTimeOffset RetrievedAt);

public sealed record ShopifyVariantSnapshot(
    string ProductId,
    string VariantId,
    string Sku,
    string? Color,
    string? Size,
    decimal Price,
    int InventoryQuantity,
    bool ProductIsActive);

public sealed record ShopifyVariantMutation(
    string ProductId,
    string VariantId,
    string Sku,
    decimal Price,
    int InventoryQuantity,
    string IdempotencyKey);

public interface ISheetReader
{
    Task<IReadOnlyList<SheetProductRow>> ReadChangedRowsAsync(
        string spreadsheetId,
        string? sheetName,
        CancellationToken cancellationToken);
}

public interface ISourceCatalogAdapter
{
    bool CanHandle(Uri sourceUri);

    Task<SourceProductSnapshot> GetProductAsync(
        Uri sourceUri,
        CancellationToken cancellationToken);
}

public interface IShopifyCatalogClient
{
    Task<ShopifyVariantSnapshot?> FindExactVariantAsync(
        string expectedSku,
        string? color,
        string? size,
        CancellationToken cancellationToken);

    Task ApplyVariantMutationAsync(
        ShopifyVariantMutation mutation,
        CancellationToken cancellationToken);

    Task<ShopifyVariantSnapshot> ReadBackVariantAsync(
        string variantId,
        CancellationToken cancellationToken);
}

public interface ISyncJobQueue
{
    Task<bool> EnqueueAsync(
        SyncJobType type,
        string idempotencyKey,
        string payloadJson,
        DateTimeOffset? availableAt,
        CancellationToken cancellationToken);

    Task<SyncJob?> ClaimNextAsync(
        string workerId,
        TimeSpan leaseDuration,
        CancellationToken cancellationToken);

    Task CompleteAsync(Guid jobId, CancellationToken cancellationToken);

    Task FailAsync(
        Guid jobId,
        string errorCode,
        string message,
        TimeSpan retryDelay,
        CancellationToken cancellationToken);
}
