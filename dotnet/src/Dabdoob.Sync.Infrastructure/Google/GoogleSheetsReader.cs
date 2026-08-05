using System.Globalization;
using System.Text;
using Dabdoob.Sync.Application.Abstractions;
using Google.Apis.Auth.OAuth2;
using Google.Apis.Services;
using Google.Apis.Sheets.v4;

namespace Dabdoob.Sync.Infrastructure.Google;

public sealed class GoogleSheetsReader : ISheetReader, IDisposable
{
    private static readonly string[] DefaultSheetNames =
    [
        "الورقة1", "الورقة2", "الورقة15", "الورقة10", "الورقة6", "الورقة7",
        "الورقة8", "الورقة20", "الورقة9", "الورقة11", "الورقة12", "الورقة13",
        "الورقة16", "الورقة19", "الورقة21", "الورقة22", "الورقة23"
    ];

    private readonly SheetsService _service;
    private readonly IReadOnlyList<string> _configuredSheetNames;
    private readonly int _maximumRow;

    public GoogleSheetsReader(IConfiguration configuration)
    {
        var encodedCredentials = configuration["Google:ServiceAccountJsonBase64"];
        if (string.IsNullOrWhiteSpace(encodedCredentials))
        {
            throw new InvalidOperationException("Google:ServiceAccountJsonBase64 is required.");
        }

        string credentialJson;
        try
        {
            credentialJson = Encoding.UTF8.GetString(Convert.FromBase64String(encodedCredentials));
        }
        catch (FormatException exception)
        {
            throw new InvalidOperationException(
                "Google:ServiceAccountJsonBase64 is not valid base64.",
                exception);
        }

        var credential = GoogleCredential
            .FromJson(credentialJson)
            .CreateScoped(SheetsService.Scope.SpreadsheetsReadonly);

        _service = new SheetsService(new BaseClientService.Initializer
        {
            HttpClientInitializer = credential,
            ApplicationName = "Dabdoob Product Sync"
        });

        _configuredSheetNames = ParseSheetNames(configuration["Google:SheetNames"]);
        _maximumRow = Math.Max(configuration.GetValue("Google:MaximumRow", 10000), 2);
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
        request.MajorDimension = SpreadsheetsResource.ValuesResource.BatchGetRequest.MajorDimensionEnum.ROWS;
        request.ValueRenderOption = SpreadsheetsResource.ValuesResource.BatchGetRequest.ValueRenderOptionEnum.UNFORMATTEDVALUE;

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

    private static IReadOnlyList<string> ParseSheetNames(string? configuredValue)
    {
        if (string.IsNullOrWhiteSpace(configuredValue))
        {
            return DefaultSheetNames;
        }

        var names = configuredValue
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        return names.Length == 0 ? DefaultSheetNames : names;
    }

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
            double value => Convert.ToDecimal(value, CultureInfo.InvariantCulture),
            float value => Convert.ToDecimal(value, CultureInfo.InvariantCulture),
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
