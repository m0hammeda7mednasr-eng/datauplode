using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dabdoob.Sync.Application.Abstractions;
using Dabdoob.Sync.Application.Catalog;
using Dabdoob.Sync.Domain.Catalog;
using Dabdoob.Sync.Domain.Jobs;
using Dabdoob.Sync.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Dabdoob.Sync.Worker.Handlers;

public sealed class ScanGoogleSheetJobHandler(
    ISheetReader sheetReader,
    IDbContextFactory<SyncDbContext> dbContextFactory,
    IConfiguration configuration,
    ILogger<ScanGoogleSheetJobHandler> logger) : ISyncJobHandler
{
    public SyncJobType JobType => SyncJobType.ScanGoogleSheet;

    public async Task HandleAsync(SyncJob job, CancellationToken cancellationToken)
    {
        var spreadsheetId = configuration["Google:SpreadsheetId"]
            ?? throw new InvalidOperationException("Google:SpreadsheetId is required.");

        var sheetName = ResolveSheetName(job.PayloadJson);
        var rows = await sheetReader.ReadChangedRowsAsync(
            spreadsheetId,
            sheetName,
            cancellationToken);

        await using var db = await dbContextFactory.CreateDbContextAsync(cancellationToken);

        var existingItems = await db.CatalogItems
            .Where(item => item.SpreadsheetId == spreadsheetId)
            .ToDictionaryAsync(
                item => CreateRowKey(item.SheetName, item.SheetRow),
                StringComparer.Ordinal,
                cancellationToken);

        var jobPrefix = $"catalog-reconcile:{spreadsheetId}:";
        var existingJobKeys = await db.SyncJobs
            .Where(candidate => candidate.Type == SyncJobType.ReconcileCatalogItem
                && candidate.IdempotencyKey.StartsWith(jobPrefix))
            .Select(candidate => candidate.IdempotencyKey)
            .ToHashSetAsync(StringComparer.Ordinal, cancellationToken);

        var created = 0;
        var changed = 0;
        var unchanged = 0;
        var invalid = 0;
        var queued = 0;

        foreach (var row in rows)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var rowKey = CreateRowKey(row.SheetName, row.RowNumber);
            string canonicalSourceKey;
            string rowFingerprint;

            try
            {
                canonicalSourceKey = CatalogIdentity.CanonicalizeSourceUrl(row.SourceUrl);
                rowFingerprint = CatalogIdentity.CreateRowFingerprint(
                    canonicalSourceKey,
                    row.PriceMultiplier,
                    row.CollectionName,
                    row.ExpectedSku);
            }
            catch (ArgumentException exception)
            {
                invalid++;
                var invalidKey = CreateInvalidSourceKey(row.SourceUrl);
                var invalidFingerprint = CatalogIdentity.CreateRowFingerprint(
                    invalidKey,
                    row.PriceMultiplier,
                    row.CollectionName,
                    row.ExpectedSku);

                if (!existingItems.TryGetValue(rowKey, out var invalidItem))
                {
                    invalidItem = CatalogItem.Create(
                        row.SpreadsheetId,
                        row.SheetName,
                        row.RowNumber,
                        row.SourceUrl,
                        invalidKey,
                        row.PriceMultiplier,
                        row.CollectionName,
                        row.ExpectedSku,
                        invalidFingerprint);
                    db.CatalogItems.Add(invalidItem);
                    existingItems[rowKey] = invalidItem;
                    created++;
                }
                else
                {
                    invalidItem.ApplySheetRow(
                        row.SourceUrl,
                        invalidKey,
                        row.PriceMultiplier,
                        row.CollectionName,
                        row.ExpectedSku,
                        invalidFingerprint);
                }

                invalidItem.MarkNeedsReview(
                    CatalogSyncStatus.NeedsReview,
                    "INVALID_SOURCE_URL",
                    exception.Message);
                continue;
            }

            CatalogItem catalogItem;
            var rowChanged = false;

            if (!existingItems.TryGetValue(rowKey, out var existingItem))
            {
                catalogItem = CatalogItem.Create(
                    row.SpreadsheetId,
                    row.SheetName,
                    row.RowNumber,
                    row.SourceUrl,
                    canonicalSourceKey,
                    row.PriceMultiplier,
                    row.CollectionName,
                    row.ExpectedSku,
                    rowFingerprint);
                db.CatalogItems.Add(catalogItem);
                existingItems[rowKey] = catalogItem;
                created++;
                rowChanged = true;
            }
            else
            {
                catalogItem = existingItem;
                rowChanged = catalogItem.ApplySheetRow(
                    row.SourceUrl,
                    canonicalSourceKey,
                    row.PriceMultiplier,
                    row.CollectionName,
                    row.ExpectedSku,
                    rowFingerprint);

                if (rowChanged)
                {
                    changed++;
                }
                else
                {
                    unchanged++;
                }
            }

            if (!rowChanged)
            {
                continue;
            }

            var idempotencyKey = $"{jobPrefix}{row.SheetName}:{row.RowNumber}:{rowFingerprint}";
            if (!existingJobKeys.Add(idempotencyKey))
            {
                continue;
            }

            var payloadJson = JsonSerializer.Serialize(new
            {
                catalogItemId = catalogItem.Id,
                row.SpreadsheetId,
                row.SheetName,
                row.RowNumber,
                rowFingerprint
            });

            db.SyncJobs.Add(SyncJob.Create(
                SyncJobType.ReconcileCatalogItem,
                idempotencyKey,
                payloadJson));
            queued++;
        }

        await db.SaveChangesAsync(cancellationToken);

        logger.LogInformation(
            "Scanned {RowCount} sheet rows. Created {Created}, changed {Changed}, unchanged {Unchanged}, invalid {Invalid}, queued {Queued}.",
            rows.Count,
            created,
            changed,
            unchanged,
            invalid,
            queued);
    }

    private static string? ResolveSheetName(string payloadJson)
    {
        if (string.IsNullOrWhiteSpace(payloadJson) || payloadJson == "{}")
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(payloadJson);
            return document.RootElement.TryGetProperty("sheetName", out var property)
                ? property.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string CreateRowKey(string sheetName, int rowNumber) =>
        $"{sheetName}\u001f{rowNumber}";

    private static string CreateInvalidSourceKey(string sourceUrl) =>
        "invalid:" + Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(sourceUrl.Trim())))
            .ToLowerInvariant();
}
