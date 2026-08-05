using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dabdoob.Sync.Domain.Jobs;
using Dabdoob.Sync.Domain.Orders;
using Dabdoob.Sync.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Dabdoob.Sync.Worker.Handlers;

public sealed class ReconcileShopifyOrderJobHandler(
    IDbContextFactory<SyncDbContext> dbContextFactory,
    ILogger<ReconcileShopifyOrderJobHandler> logger) : ISyncJobHandler
{
    public SyncJobType JobType => SyncJobType.ReconcileShopifyOrder;

    public async Task HandleAsync(SyncJob job, CancellationToken cancellationToken)
    {
        using var payloadDocument = JsonDocument.Parse(job.PayloadJson);
        if (!payloadDocument.RootElement.TryGetProperty("body", out var body))
        {
            throw new InvalidOperationException("Shopify webhook payload does not contain body.");
        }

        var orderId = ReadRequiredString(body, "id");
        var orderName = ReadRequiredString(body, "name");
        var createdAt = ReadDate(body, "created_at", DateTimeOffset.UtcNow);
        var updatedAt = ReadDate(body, "updated_at", createdAt);
        var snapshotJson = body.GetRawText();
        var fingerprint = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(snapshotJson)))
            .ToLowerInvariant();

        await using var db = await dbContextFactory.CreateDbContextAsync(cancellationToken);
        var order = await db.ShopifyOrders
            .SingleOrDefaultAsync(candidate => candidate.ShopifyOrderId == orderId, cancellationToken);

        if (order is not null
            && string.Equals(order.SourceFingerprint, fingerprint, StringComparison.Ordinal))
        {
            logger.LogInformation(
                "Shopify order {OrderName} already has fingerprint {Fingerprint}; webhook is a duplicate.",
                orderName,
                fingerprint);
            return;
        }

        if (order is null)
        {
            order = ShopifyOrder.Create(orderId, orderName, createdAt);
            db.ShopifyOrders.Add(order);
        }

        var customer = body.TryGetProperty("customer", out var customerElement)
            && customerElement.ValueKind == JsonValueKind.Object
                ? customerElement
                : default;

        order.ApplySnapshot(
            ReadOptionalString(customer, "id"),
            BuildCustomerName(customer),
            ReadOptionalString(body, "email"),
            ReadOptionalString(body, "phone")
                ?? ReadNestedOptionalString(body, "billing_address", "phone")
                ?? ReadNestedOptionalString(body, "shipping_address", "phone"),
            ReadOptionalString(body, "financial_status") ?? "unknown",
            ReadOptionalString(body, "fulfillment_status") ?? "unfulfilled",
            ReadOptionalString(body, "currency") ?? "EGP",
            ReadDecimal(body, "current_total_price"),
            CountLineItems(body),
            HasNonNullProperty(body, "cancelled_at"),
            updatedAt,
            fingerprint,
            snapshotJson);

        await db.SaveChangesAsync(cancellationToken);

        logger.LogInformation(
            "Synchronized Shopify order {OrderName} ({ShopifyOrderId}) updated at {UpdatedAt}.",
            orderName,
            orderId,
            updatedAt);
    }

    private static string ReadRequiredString(JsonElement element, string propertyName) =>
        ReadOptionalString(element, propertyName)
        ?? throw new InvalidOperationException($"Shopify order is missing {propertyName}.");

    private static string? ReadOptionalString(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object
            || !element.TryGetProperty(propertyName, out var property)
            || property.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return null;
        }

        return property.ValueKind == JsonValueKind.String
            ? property.GetString()?.Trim()
            : property.GetRawText().Trim('"');
    }

    private static string? ReadNestedOptionalString(
        JsonElement element,
        string objectProperty,
        string valueProperty)
    {
        return element.TryGetProperty(objectProperty, out var nested)
            ? ReadOptionalString(nested, valueProperty)
            : null;
    }

    private static DateTimeOffset ReadDate(
        JsonElement element,
        string propertyName,
        DateTimeOffset fallback)
    {
        var value = ReadOptionalString(element, propertyName);
        return DateTimeOffset.TryParse(
            value,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal,
            out var parsed)
                ? parsed
                : fallback;
    }

    private static decimal ReadDecimal(JsonElement element, string propertyName)
    {
        var value = ReadOptionalString(element, propertyName);
        return decimal.TryParse(
            value,
            NumberStyles.Number,
            CultureInfo.InvariantCulture,
            out var parsed)
                ? parsed
                : 0;
    }

    private static int CountLineItems(JsonElement body)
    {
        if (!body.TryGetProperty("line_items", out var items)
            || items.ValueKind != JsonValueKind.Array)
        {
            return 0;
        }

        var count = 0;
        foreach (var item in items.EnumerateArray())
        {
            if (item.TryGetProperty("quantity", out var quantity)
                && quantity.TryGetInt32(out var quantityValue))
            {
                count += Math.Max(quantityValue, 0);
            }
            else
            {
                count++;
            }
        }

        return count;
    }

    private static bool HasNonNullProperty(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var value)
        && value.ValueKind is not JsonValueKind.Null and not JsonValueKind.Undefined;

    private static string? BuildCustomerName(JsonElement customer)
    {
        var parts = new[]
        {
            ReadOptionalString(customer, "first_name"),
            ReadOptionalString(customer, "last_name")
        };

        var name = string.Join(' ', parts.Where(part => !string.IsNullOrWhiteSpace(part)));
        return string.IsNullOrWhiteSpace(name) ? null : name;
    }
}
