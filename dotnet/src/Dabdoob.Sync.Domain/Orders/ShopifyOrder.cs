namespace Dabdoob.Sync.Domain.Orders;

public sealed class ShopifyOrder
{
    private ShopifyOrder()
    {
    }

    public Guid Id { get; private set; } = Guid.NewGuid();
    public string ShopifyOrderId { get; private set; } = string.Empty;
    public string OrderName { get; private set; } = string.Empty;
    public string? CustomerId { get; private set; }
    public string? CustomerName { get; private set; }
    public string? Email { get; private set; }
    public string? Phone { get; private set; }
    public string FinancialStatus { get; private set; } = string.Empty;
    public string FulfillmentStatus { get; private set; } = string.Empty;
    public string CurrencyCode { get; private set; } = string.Empty;
    public decimal CurrentTotalPrice { get; private set; }
    public int LineItemCount { get; private set; }
    public bool IsCancelled { get; private set; }
    public DateTimeOffset ShopifyCreatedAt { get; private set; }
    public DateTimeOffset ShopifyUpdatedAt { get; private set; }
    public string SourceFingerprint { get; private set; } = string.Empty;
    public string SnapshotJson { get; private set; } = "{}";
    public DateTimeOffset FirstSyncedAt { get; private set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset LastSyncedAt { get; private set; } = DateTimeOffset.UtcNow;

    public static ShopifyOrder Create(
        string shopifyOrderId,
        string orderName,
        DateTimeOffset shopifyCreatedAt)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(shopifyOrderId);
        ArgumentException.ThrowIfNullOrWhiteSpace(orderName);

        return new ShopifyOrder
        {
            ShopifyOrderId = shopifyOrderId.Trim(),
            OrderName = orderName.Trim(),
            ShopifyCreatedAt = shopifyCreatedAt,
            ShopifyUpdatedAt = shopifyCreatedAt
        };
    }

    public void ApplySnapshot(
        string? customerId,
        string? customerName,
        string? email,
        string? phone,
        string financialStatus,
        string fulfillmentStatus,
        string currencyCode,
        decimal currentTotalPrice,
        int lineItemCount,
        bool isCancelled,
        DateTimeOffset shopifyUpdatedAt,
        string sourceFingerprint,
        string snapshotJson)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(financialStatus);
        ArgumentException.ThrowIfNullOrWhiteSpace(fulfillmentStatus);
        ArgumentException.ThrowIfNullOrWhiteSpace(currencyCode);
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceFingerprint);
        ArgumentException.ThrowIfNullOrWhiteSpace(snapshotJson);
        ArgumentOutOfRangeException.ThrowIfNegative(currentTotalPrice);
        ArgumentOutOfRangeException.ThrowIfNegative(lineItemCount);

        CustomerId = customerId;
        CustomerName = customerName;
        Email = email;
        Phone = phone;
        FinancialStatus = financialStatus;
        FulfillmentStatus = fulfillmentStatus;
        CurrencyCode = currencyCode;
        CurrentTotalPrice = currentTotalPrice;
        LineItemCount = lineItemCount;
        IsCancelled = isCancelled;
        ShopifyUpdatedAt = shopifyUpdatedAt;
        SourceFingerprint = sourceFingerprint;
        SnapshotJson = snapshotJson;
        LastSyncedAt = DateTimeOffset.UtcNow;
    }
}
