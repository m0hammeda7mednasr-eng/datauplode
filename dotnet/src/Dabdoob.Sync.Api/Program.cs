using System.Text.Json;
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

    return Results.Ok(new { jobs, catalog, checkedAt = DateTimeOffset.UtcNow });
});

app.MapPost("/webhooks/google-drive", async (
    HttpRequest request,
    ISyncJobQueue queue,
    CancellationToken cancellationToken) =>
{
    var channelId = request.Headers["X-Goog-Channel-ID"].ToString();
    var messageNumber = request.Headers["X-Goog-Message-Number"].ToString();
    var resourceState = request.Headers["X-Goog-Resource-State"].ToString();

    if (string.IsNullOrWhiteSpace(channelId) || string.IsNullOrWhiteSpace(messageNumber))
    {
        return Results.BadRequest();
    }

    var payload = JsonSerializer.Serialize(new { channelId, messageNumber, resourceState });
    await queue.EnqueueAsync(
        SyncJobType.ReconcileSheetRow,
        $"google-drive:{channelId}:{messageNumber}",
        payload,
        null,
        cancellationToken);

    return Results.NoContent();
});

app.Run();

public sealed record EnqueueSyncJobRequest(
    SyncJobType Type,
    string IdempotencyKey,
    object? Payload,
    DateTimeOffset? AvailableAt);

public partial class Program;
