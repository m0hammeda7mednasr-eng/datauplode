using Dabdoob.Sync.Domain.Catalog;
using Dabdoob.Sync.Domain.Jobs;
using Dabdoob.Sync.Domain.Orders;
using Microsoft.EntityFrameworkCore;

namespace Dabdoob.Sync.Infrastructure.Persistence;

public sealed class SyncDbContext(DbContextOptions<SyncDbContext> options) : DbContext(options)
{
    public DbSet<CatalogItem> CatalogItems => Set<CatalogItem>();
    public DbSet<ShopifyOrder> ShopifyOrders => Set<ShopifyOrder>();
    public DbSet<SyncJob> SyncJobs => Set<SyncJob>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var catalog = modelBuilder.Entity<CatalogItem>();
        catalog.ToTable("catalog_items");
        catalog.HasKey(x => x.Id);
        catalog.Property(x => x.SourceUrl).HasMaxLength(2048);
        catalog.Property(x => x.CanonicalSourceKey).HasMaxLength(512);
        catalog.Property(x => x.SpreadsheetId).HasMaxLength(256);
        catalog.Property(x => x.SheetName).HasMaxLength(256);
        catalog.Property(x => x.CollectionName).HasMaxLength(512);
        catalog.Property(x => x.ExpectedSku).HasMaxLength(256);
        catalog.Property(x => x.ShopifyProductId).HasMaxLength(256);
        catalog.Property(x => x.ShopifyVariantId).HasMaxLength(256);
        catalog.Property(x => x.SourceFingerprint).HasMaxLength(256);
        catalog.Property(x => x.LastErrorCode).HasMaxLength(128);
        catalog.Property(x => x.LastErrorMessage).HasMaxLength(4000);
        catalog.HasIndex(x => new { x.SpreadsheetId, x.SheetName, x.SheetRow }).IsUnique();
        catalog.HasIndex(x => x.CanonicalSourceKey);
        catalog.HasIndex(x => x.ExpectedSku);
        catalog.HasIndex(x => x.NextCheckAt);

        var orders = modelBuilder.Entity<ShopifyOrder>();
        orders.ToTable("shopify_orders");
        orders.HasKey(x => x.Id);
        orders.Property(x => x.ShopifyOrderId).HasMaxLength(256);
        orders.Property(x => x.OrderName).HasMaxLength(128);
        orders.Property(x => x.CustomerId).HasMaxLength(256);
        orders.Property(x => x.CustomerName).HasMaxLength(512);
        orders.Property(x => x.Email).HasMaxLength(512);
        orders.Property(x => x.Phone).HasMaxLength(128);
        orders.Property(x => x.FinancialStatus).HasMaxLength(64);
        orders.Property(x => x.FulfillmentStatus).HasMaxLength(64);
        orders.Property(x => x.CurrencyCode).HasMaxLength(8);
        orders.Property(x => x.CurrentTotalPrice).HasPrecision(18, 2);
        orders.Property(x => x.SourceFingerprint).HasMaxLength(128);
        orders.Property(x => x.SnapshotJson).HasColumnType("jsonb");
        orders.HasIndex(x => x.ShopifyOrderId).IsUnique();
        orders.HasIndex(x => x.OrderName);
        orders.HasIndex(x => x.ShopifyUpdatedAt);
        orders.HasIndex(x => x.LastSyncedAt);

        var jobs = modelBuilder.Entity<SyncJob>();
        jobs.ToTable("sync_jobs");
        jobs.HasKey(x => x.Id);
        jobs.Property(x => x.IdempotencyKey).HasMaxLength(512);
        jobs.Property(x => x.PayloadJson).HasColumnType("jsonb");
        jobs.Property(x => x.LockedBy).HasMaxLength(256);
        jobs.Property(x => x.LastErrorCode).HasMaxLength(128);
        jobs.Property(x => x.LastErrorMessage).HasMaxLength(4000);
        jobs.HasIndex(x => x.IdempotencyKey).IsUnique();
        jobs.HasIndex(x => new { x.Status, x.AvailableAt });
        jobs.HasIndex(x => x.LockedUntil);
    }
}
