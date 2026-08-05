using System.Globalization;
using System.Text;
using Dabdoob.Sync.Application.Abstractions;
using Google.Apis.Auth.OAuth2;
using Google.Apis.Services;
using Google.Apis.Sheets.v4;

namespace Dabdoob.Sync.Infrastructure.Google;

public sealed record GoogleSheetsReaderOptions(
    string ServiceAccountJsonBase64,
    IReadOnlyList<string> SheetNames,
    int MaximumRow);

public sealed class GoogleSheetsReader : ISheetReader, IDisposable
{
    public static readonly string[] DefaultSheetNames =
    [
        "الورقة1", "الورقة2", "الورقة15", "الورقة10", "الورقة6", "الورقة7",
        "الورقة8", "الورقة20", "الورقة9", "الورقة11", "الورقة12", "الورقة13",
        "الورقة16", "الورقة19", "الورقة21", "الورقة22", "الورقة23"
    ];

    private readonly SheetsService _service;
    private readonly IReadOnlyList<string> _configuredSheetNames;
    private readonly int _maximumRow;

    public GoogleSheetsReader(GoogleSheetsReaderOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.ServiceAccountJsonBase64);

        string credentialJson;
        try
        {
            credentialJson = Encoding.UTF8.GetString(
                Convert.FromBase64String(options.ServiceAccountJsonBase64));
        }
        catch (FormatException exception)
        {
            throw new InvalidOperationException(
                "Google service-account credentials are not valid base64.",
                exception);
        }

        var serviceAccountCredential =
            CredentialFactory.FromJson<ServiceAccountCredential>(credentialJson);
        var credential = serviceAccountCredential
            .ToGoogleCredential()
            .CreateScoped(SheetsService.Scope.SpreadsheetsReadonly);

        _service = new SheetsService(new BaseClientService.Initializer
        {
            HttpClientInitializer = credential,
            ApplicationName = "Dabdoob Product Sync"
        });

        _configuredSheetNames = options.SheetNames.Count == 0
            ? DefaultSheetNames
            : options.SheetNames
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Select(name => name.Trim())
                .Distinct(StringComparer.Ordinal)
                .ToArray();
        _maximumRow = Math.Max(options.MaximumRow, 2);
    }

    public async Task<IReadOnlyList<SheetProductRow>> ReadChangedRowsAsync(
        string spreadsheetId,
        string? sheetName,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(spreadsheetId);

        var sheetNames = string.IsNullOrWhiteSpace(sheetName)
            ? _configuredSheetNames
            : [sheetName.Trim()];

        var request = _service.Spreadsheets.Values.BatchGet(spreadsheetId.Trim());
        request.Ranges = sheetNames
            .Select(name => $"'{name.Replace("'", "''", StringComparison.Ordinal)}'!A2:D{_maximumRow}")
            .ToList();

        var response = await request.ExecuteAsync(cancellationToken);
        var rows = new List<SheetProductRow>();

        foreach (var valueRange in response.ValueRanges ?? [])
        {
            var resolvedSheetName = ResolveSheetName(valueRange.Range);
            var values = valueRange.Values ?? [];

            for (var index = 0; index < values.Count; index++)
            {
                var valuesRow = values[index];
                var sourceUrl = GetString(valuesRow, 0);
                if (string.IsNullOrWhiteSpace(sourceUrl))
                {
                    continue;
                }

                var multiplier = GetDecimal(valuesRow, 1);
                if (multiplier <= 0)
                {
                    continue;
                }

                rows.Add(new SheetProductRow(
                    spreadsheetId.Trim(),
                    resolvedSheetName,
                    index + 2,
                    sourceUrl.Trim(),
                    multiplier,
                    GetString(valuesRow, 2).Trim(),
                    GetString(valuesRow, 3).Trim()));
            }
        }

        return rows;
    }

    public void Dispose() => _service.Dispose();

    private static string ResolveSheetName(string? range)
    {
        if (string.IsNullOrWhiteSpace(range))
        {
            return string.Empty;
        }

        var separator = range.IndexOf('!');
        var rawName = separator >= 0 ? range[..separator] : range;
        return rawName.Trim().Trim('\'').Replace("''", "'", StringComparison.Ordinal);
    }

    private static string GetString(IList<object> row, int index)
    {
        if (index >= row.Count || row[index] is null)
        {
            return string.Empty;
        }

        return Convert.ToString(row[index], CultureInfo.InvariantCulture) ?? string.Empty;
    }

    private static decimal GetDecimal(IList<object> row, int index)
    {
        if (index >= row.Count || row[index] is null)
        {
            return 0;
        }

        return row[index] switch
        {
            decimal value => value,
            double value => (decimal)value,
            float value => (decimal)value,
            long value => value,
            int value => value,
            _ when decimal.TryParse(
                Convert.ToString(row[index], CultureInfo.InvariantCulture),
                NumberStyles.Number,
                CultureInfo.InvariantCulture,
                out var parsed) => parsed,
            _ => 0
        };
    }
}
