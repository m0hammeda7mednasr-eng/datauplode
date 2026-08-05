using System.Text.Json;
using Dabdoob.Sync.Api.Security;
using Dabdoob.Sync.Application.Abstractions;
using Dabdoob.Sync.Domain.Jobs;

namespace Dabdoob.Sync.Api.Endpoints;

public static class ShopifyWebhookEndpoints
{
    private const long MaximumWebhookBytes = 10 * 1024 * 1024;

    public static IEndpointRouteBuilder MapShopifyWebhooks(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/webhooks/shopify", HandleAsync)
            .DisableAntiforgery();

        return endpoints;
    }

    private static async Task<IResult> HandleAsync(
        HttpRequest request,
        ShopifyWebhookVerifier verifier,
        ISyncJobQueue queue,
        CancellationToken cancellationToken)
    {
        if (request.ContentLength is > MaximumWebhookBytes)
        {
            return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
        }

        await using var buffer = new MemoryStream();
        await request.Body.CopyToAsync(buffer, cancellationToken);
        if (buffer.Length is 0 or > MaximumWebhookBytes)
        {
            return Results.BadRequest();
        }

        var body = buffer.ToArray();
        var suppliedHmac = request.Headers["X-Shopify-Hmac-Sha256"].ToString();
        if (!verifier.IsValid(body, suppliedHmac))
        {
            return Results.Unauthorized();
        }

        var topic = request.Headers["X-Shopify-Topic"].ToString().Trim().ToLowerInvariant();
        var webhookId = request.Headers["X-Shopify-Webhook-Id"].ToString().Trim();
        var shopDomain = request.Headers["X-Shopify-Shop-Domain"].ToString().Trim().ToLowerInvariant();

        if (string.IsNullOrWhiteSpace(topic)
            || string.IsNullOrWhiteSpace(webhookId)
            || string.IsNullOrWhiteSpace(shopDomain))
        {
            return Results.BadRequest();
        }

        var jobType = topic switch
        {
            "orders/create" or "orders/updated" or "orders/cancelled" or "orders/fulfilled"
                => SyncJobType.ReconcileShopifyOrder,
            "products/create" or "products/update" or "products/delete"
                => SyncJobType.ReconcileShopifyProduct,
            _ => (SyncJobType?)null
        };

        if (jobType is null)
        {
            return Results.NoContent();
        }

        JsonElement webhookBody;
        try
        {
            using var document = JsonDocument.Parse(body);
            webhookBody = document.RootElement.Clone();
        }
        catch (JsonException)
        {
            return Results.BadRequest();
        }

        var payloadJson = JsonSerializer.Serialize(new
        {
            webhookId,
            topic,
            shopDomain,
            receivedAt = DateTimeOffset.UtcNow,
            body = webhookBody
        });

        await queue.EnqueueAsync(
            jobType.Value,
            $"shopify-webhook:{shopDomain}:{webhookId}",
            payloadJson,
            null,
            cancellationToken);

        return Results.NoContent();
    }
}
