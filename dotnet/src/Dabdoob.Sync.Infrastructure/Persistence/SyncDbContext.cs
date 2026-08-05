using Dabdoob.Sync.Domain.Catalog;
using Dabdoob.Sync.Domain.Jobs;
using Microsoft.EntityFrameworkCore;

namespace Dabdoob.Sync.Infrastructure.Persistence;

public sealed class SyncDbContext(DbContextOptions<SyncDbContext> options) : DbContext(options)
{
    public DbSet<CatalogItem> CatalogItems => Set<CatalogItem>();
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
