using System.Text.Json;
using Dabdoob.Sync.Api.Endpoints;
using Dabdoob.Sync.Api.Security;
using Dabdoob.Sync.Application.Abstractions;
using Dabdoob.Sync.Domain.Jobs;
using Dabdoob.Sync.Infrastructure.Jobs;
using Dabdoob.Sync.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

var connectionString = builder.Configuration.GetConnectionString("Postgres")
    ?? throw new InvalidOperationException("ConnectionStrings:Postgres is required.");

builder.Services.AddDbContextFactory<SyncDbContext>(options =>
    options.UseNpgsql(connectionString, npgsql => npgsql.EnableRetryOnFailure()));
builder.Services.AddScoped<ISyncJobQueue, PostgresSyncJobQueue>();
builder.Services.AddSingleton<ShopifyWebhookVerifier>();

var app = builder.Build();

await using (var scope = app.Services.CreateAsyncScope())
{
    var dbFactory = scope.ServiceProvider.GetRequiredService<IDbContextFactory<SyncDbContext>>();
    await using var db = await dbFactory.CreateDbContextAsync();
    await db.Database.EnsureCreatedAsync();
}

app.MapGet("/", () => Results.Ok(new
{
    service = "Dabdoob.Sync.Api",
    status = "ok",
    framework = ".NET 10"
}));

app.MapGet("/health/live", () => Results.Ok(new { status = "live" }));

app.MapGet("/health/ready", async (
    IDbContextFactory<SyncDbContext> dbFactory,
    CancellationToken cancellationToken) =>
{
    await using var db = await dbFactory.CreateDbContextAsync(cancellationToken);
    return await db.Database.CanConnectAsync(cancellationToken)
        ? Results.Ok(new { status = "ready" })
        : Results.Problem("PostgreSQL is unavailable.", statusCode: StatusCodes.Status503ServiceUnavailable);
});

app.MapPost("/api/sync/jobs", async (
    EnqueueSyncJobRequest request,
    ISyncJobQueue queue,
    CancellationToken cancellationToken) =>
{
    if (string.IsNullOrWhiteSpace(request.IdempotencyKey))
    {
        return Results.ValidationProblem(new Dictionary<string, string[]>
        {
            [nameof(request.IdempotencyKey)] = ["IdempotencyKey is required."]
        });
    }

    var payloadJson = JsonSerializer.Serialize(request.Payload ?? new { });
    var created = await queue.EnqueueAsync(
        request.Type,
        request.IdempotencyKey,
        payloadJson,
        request.AvailableAt,
        cancellationToken);

    return created
        ? Results.Accepted(value: new { queued = true, request.IdempotencyKey })
        : Results.Ok(new { queued = false, duplicate = true, request.IdempotencyKey });
});

app.MapGet("/api/sync/status", async (
    IDbContextFactory<SyncDbContext> dbFactory,
    IConfiguration configuration,
    CancellationToken cancellationToken) =>
{
    await using var db = await dbFactory.CreateDbContextAsync(cancellationToken);

    var jobs = await db.SyncJobs
        .GroupBy(x => x.Status)
        .Select(group => new { status = group.Key.ToString(), count = group.Count() })
        .ToListAsync(cancellationToken);

    var catalog = await db.CatalogItems
        .GroupBy(x => x.Status)
        .Select(group => new { status = group.Key.ToString(), count = group.Count() })
        .ToListAsync(cancellationToken);

    var orders = new
    {
        total = await db.ShopifyOrders.CountAsync(cancellationToken),
        cancelled = await db.ShopifyOrders.CountAsync(x => x.IsCancelled, cancellationToken),
        latestShopifyUpdate = await db.ShopifyOrders
            .OrderByDescending(x => x.ShopifyUpdatedAt)
            .Select(x => (DateTimeOffset?)x.ShopifyUpdatedAt)
            .FirstOrDefaultAsync(cancellationToken),
        latestSync = await db.ShopifyOrders
            .OrderByDescending(x => x.LastSyncedAt)
            .Select(x => (DateTimeOffset?)x.LastSyncedAt)
            .FirstOrDefaultAsync(cancellationToken)
    };

    return Results.Ok(new
    {
        dryRun = configuration.GetValue("Sync:DryRun", true),
        jobs,
        catalog,
        orders,
        checkedAt = DateTimeOffset.UtcNow
    });
});

app.MapPost("/webhooks/google-drive", async (
    HttpRequest request,
    ISyncJobQueue queue,
    IConfiguration configuration,
    CancellationToken cancellationToken) =>
{
    var channelId = request.Headers["X-Goog-Channel-ID"].ToString();
    var messageNumber = request.Headers["X-Goog-Message-Number"].ToString();
    var resourceState = request.Headers["X-Goog-Resource-State"].ToString();
    var suppliedToken = request.Headers["X-Goog-Channel-Token"].ToString();
    var expectedToken = configuration["Google:DriveWebhookToken"];

    if (string.IsNullOrWhiteSpace(channelId)
        || string.IsNullOrWhiteSpace(messageNumber)
        || string.IsNullOrWhiteSpace(expectedToken)
        || !string.Equals(suppliedToken, expectedToken, StringComparison.Ordinal))
    {
        return Results.Unauthorized();
    }

    var payload = JsonSerializer.Serialize(new { channelId, messageNumber, resourceState });
    await queue.EnqueueAsync(
        SyncJobType.ScanGoogleSheet,
        $"google-drive:{channelId}:{messageNumber}",
        payload,
        null,
        cancellationToken);

    return Results.NoContent();
});

app.MapShopifyWebhooks();

app.Run();

public sealed record EnqueueSyncJobRequest(
    SyncJobType Type,
    string IdempotencyKey,
    object? Payload,
    DateTimeOffset? AvailableAt);

public partial class Program;
