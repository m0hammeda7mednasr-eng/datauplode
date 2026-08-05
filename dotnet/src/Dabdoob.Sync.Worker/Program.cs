using Dabdoob.Sync.Application.Abstractions;
using Dabdoob.Sync.Infrastructure.Google;
using Dabdoob.Sync.Infrastructure.Jobs;
using Dabdoob.Sync.Infrastructure.Persistence;
using Dabdoob.Sync.Worker;
using Dabdoob.Sync.Worker.Handlers;
using Microsoft.EntityFrameworkCore;

var builder = Host.CreateApplicationBuilder(args);

var connectionString = builder.Configuration.GetConnectionString("Postgres")
    ?? throw new InvalidOperationException("ConnectionStrings:Postgres is required.");

builder.Services.AddPooledDbContextFactory<SyncDbContext>(options =>
    options.UseNpgsql(connectionString, npgsql => npgsql.EnableRetryOnFailure()));
builder.Services.AddSingleton<ISyncJobQueue, PostgresSyncJobQueue>();
builder.Services.AddSingleton<ISheetReader, GoogleSheetsReader>();
builder.Services.AddSingleton<ISyncJobHandler, ScanGoogleSheetJobHandler>();
builder.Services.AddSingleton<ISyncJobHandler, ReconcileShopifyOrderJobHandler>();
builder.Services.AddHostedService<SyncWorker>();

var host = builder.Build();

await using (var scope = host.Services.CreateAsyncScope())
{
    var dbFactory = scope.ServiceProvider.GetRequiredService<IDbContextFactory<SyncDbContext>>();
    await using var db = await dbFactory.CreateDbContextAsync();
    await db.Database.EnsureCreatedAsync();
}

await host.RunAsync();
