using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using Dabdoob.Sync.Application.Abstractions;

namespace Dabdoob.Sync.Infrastructure.Shopify;

public sealed record ShopifyClientOptions(
    string ShopDomain,
    string AdminAccessToken,
    string ApiVersion,
    bool DryRun);

public sealed class ShopifyGraphQlCatalogClient : IShopifyCatalogClient
{
    private const string FindVariantQuery = """
        query FindExactVariant($query: String!, $first: Int!, $after: String) {
          productVariants(first: $first, after: $after, query: $query) {
            nodes {
              id
              sku
              title
              price
              inventoryQuantity
              selectedOptions { name value }
              product { id title status }
              inventoryItem { id }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
        """;

    private const string ReadVariantQuery = """
        query ReadVariant($id: ID!) {
          productVariant(id: $id) {
            id
            sku
            title
            price
            inventoryQuantity
            selectedOptions { name value }
            product { id title status }
            inventoryItem { id }
          }
        }
        """;

    private readonly HttpClient _httpClient;
    private readonly ShopifyClientOptions _options;

    public ShopifyGraphQlCatalogClient(HttpClient httpClient, ShopifyClientOptions options)
    {
        ArgumentNullException.ThrowIfNull(httpClient);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.ShopDomain);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.AdminAccessToken);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.ApiVersion);

        _httpClient = httpClient;
        _options = options;

        var domain = options.ShopDomain
            .Replace("https://", string.Empty, StringComparison.OrdinalIgnoreCase)
            .Replace("http://", string.Empty, StringComparison.OrdinalIgnoreCase)
            .Trim()
            .TrimEnd('/');

        _httpClient.BaseAddress = new Uri(
            $"https://{domain}/admin/api/{options.ApiVersion.Trim()}/graphql.json");
        _httpClient.DefaultRequestHeaders.Remove("X-Shopify-Access-Token");
        _httpClient.DefaultRequestHeaders.Add("X-Shopify-Access-Token", options.AdminAccessToken.Trim());
        _httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("DabdoobProductSync/1.0");
        _httpClient.Timeout = TimeSpan.FromSeconds(60);
    }

    public async Task<ShopifyVariantSnapshot?> FindExactVariantAsync(
        string expectedSku,
        string? color,
        string? size,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(expectedSku))
        {
            return null;
        }

        var search = $"sku:\"{EscapeSearchValue(expectedSku.Trim())}\" status:active";
        string? after = null;
        var candidates = new List<ShopifyVariantSnapshot>();

        for (var page = 0; page < 5; page++)
        {
            using var document = await ExecuteAsync(
                FindVariantQuery,
                new { query = search, first = 20, after },
                cancellationToken);

            var connection = document.RootElement
                .GetProperty("data")
                .GetProperty("productVariants");

            foreach (var node in connection.GetProperty("nodes").EnumerateArray())
            {
                var snapshot = ParseVariant(node);
                if (!string.Equals(snapshot.Sku, expectedSku.Trim(), StringComparison.Ordinal)
                    || !snapshot.ProductIsActive
                    || !MatchesOption(snapshot.Color, color)
                    || !MatchesOption(snapshot.Size, size))
                {
                    continue;
                }

                candidates.Add(snapshot);
            }

            var pageInfo = connection.GetProperty("pageInfo");
            if (!pageInfo.GetProperty("hasNextPage").GetBoolean())
            {
                break;
            }

            after = pageInfo.GetProperty("endCursor").GetString();
            if (string.IsNullOrWhiteSpace(after))
            {
                break;
            }
        }

        return candidates.Count == 1 ? candidates[0] : null;
    }

    public Task ApplyVariantMutationAsync(
        ShopifyVariantMutation mutation,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        throw _options.DryRun
            ? new InvalidOperationException(
                "Shopify mutation was blocked because Sync:DryRun is enabled.")
            : new NotSupportedException(
                "Shopify mutation execution is not enabled until mutation schemas and canary tests pass.");
    }

    public async Task<ShopifyVariantSnapshot> ReadBackVariantAsync(
        string variantId,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(variantId);

        using var document = await ExecuteAsync(
            ReadVariantQuery,
            new { id = variantId.Trim() },
            cancellationToken);

        var data = document.RootElement.GetProperty("data");
        if (!data.TryGetProperty("productVariant", out var variant)
            || variant.ValueKind == JsonValueKind.Null)
        {
            throw new InvalidOperationException($"Shopify variant {variantId} was not found during read-back.");
        }

        return ParseVariant(variant);
    }

    private async Task<JsonDocument> ExecuteAsync(
        string query,
        object variables,
        CancellationToken cancellationToken)
    {
        using var response = await _httpClient.PostAsJsonAsync(
            string.Empty,
            new { query, variables },
            cancellationToken);

        var responseText = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException(
                $"Shopify GraphQL returned HTTP {(int)response.StatusCode}: {responseText}",
                null,
                response.StatusCode);
        }

        var document = JsonDocument.Parse(responseText);
        if (document.RootElement.TryGetProperty("errors", out var errors)
            && errors.ValueKind == JsonValueKind.Array
            && errors.GetArrayLength() > 0)
        {
            var message = string.Join(" | ", errors.EnumerateArray().Select(error =>
                error.TryGetProperty("message", out var value)
                    ? value.GetString()
                    : error.GetRawText()));
            document.Dispose();
            throw new InvalidOperationException($"Shopify GraphQL error: {message}");
        }

        return document;
    }

    private static ShopifyVariantSnapshot ParseVariant(JsonElement node)
    {
        var selectedOptions = node.GetProperty("selectedOptions")
            .EnumerateArray()
            .ToDictionary(
                option => option.GetProperty("name").GetString() ?? string.Empty,
                option => option.GetProperty("value").GetString() ?? string.Empty,
                StringComparer.OrdinalIgnoreCase);

        var product = node.GetProperty("product");
        var sku = node.TryGetProperty("sku", out var skuElement)
            && skuElement.ValueKind != JsonValueKind.Null
                ? skuElement.GetString() ?? string.Empty
                : string.Empty;
        var priceText = node.GetProperty("price").GetString() ?? "0";
        var inventory = node.TryGetProperty("inventoryQuantity", out var inventoryElement)
            && inventoryElement.ValueKind != JsonValueKind.Null
                ? inventoryElement.GetInt32()
                : 0;

        return new ShopifyVariantSnapshot(
            product.GetProperty("id").GetString() ?? string.Empty,
            node.GetProperty("id").GetString() ?? string.Empty,
            sku,
            FindOption(selectedOptions, "color", "colour"),
            FindOption(selectedOptions, "size"),
            decimal.Parse(priceText, NumberStyles.Number, CultureInfo.InvariantCulture),
            inventory,
            string.Equals(
                product.GetProperty("status").GetString(),
                "ACTIVE",
                StringComparison.Ordinal));
    }

    private static string? FindOption(
        IReadOnlyDictionary<string, string> selectedOptions,
        params string[] names)
    {
        foreach (var pair in selectedOptions)
        {
            if (names.Any(name => pair.Key.Contains(name, StringComparison.OrdinalIgnoreCase)))
            {
                return pair.Value;
            }
        }

        return null;
    }

    private static bool MatchesOption(string? actual, string? expected)
    {
        if (string.IsNullOrWhiteSpace(expected))
        {
            return true;
        }

        return string.Equals(
            NormalizeOption(actual),
            NormalizeOption(expected),
            StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizeOption(string? value) =>
        string.Join(' ', (value ?? string.Empty)
            .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));

    private static string EscapeSearchValue(string value) =>
        value.Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal);
}
