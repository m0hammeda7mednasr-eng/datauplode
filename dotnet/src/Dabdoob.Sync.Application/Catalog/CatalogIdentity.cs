using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Dabdoob.Sync.Application.Catalog;

public static class CatalogIdentity
{
    private static readonly HashSet<string> TrackingParameters = new(StringComparer.OrdinalIgnoreCase)
    {
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
        "gclid", "fbclid", "msclkid", "ref", "source"
    };

    public static string CanonicalizeSourceUrl(string sourceUrl)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceUrl);

        if (!Uri.TryCreate(sourceUrl.Trim(), UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            throw new ArgumentException("Source URL must be an absolute HTTP(S) URL.", nameof(sourceUrl));
        }

        var queryPairs = ParseQuery(uri.Query)
            .Where(pair => !TrackingParameters.Contains(pair.Key))
            .OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .ThenBy(pair => pair.Value, StringComparer.Ordinal)
            .Select(pair => string.IsNullOrEmpty(pair.Value)
                ? Uri.EscapeDataString(pair.Key)
                : $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value)}");

        var builder = new UriBuilder(uri)
        {
            Scheme = Uri.UriSchemeHttps,
            Host = uri.IdnHost.ToLowerInvariant(),
            Port = -1,
            Path = NormalizePath(uri.AbsolutePath),
            Query = string.Join('&', queryPairs),
            Fragment = uri.Fragment.TrimStart('#').Trim().ToLowerInvariant()
        };

        return builder.Uri.AbsoluteUri.TrimEnd('/');
    }

    public static string CreateRowFingerprint(
        string canonicalSourceKey,
        decimal multiplier,
        string collectionName,
        string expectedSku)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(canonicalSourceKey);

        var canonicalText = string.Join('|',
            canonicalSourceKey.Trim(),
            multiplier.ToString("0.############################", CultureInfo.InvariantCulture),
            NormalizeText(collectionName),
            NormalizeText(expectedSku));

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalText)))
            .ToLowerInvariant();
    }

    private static string NormalizePath(string path)
    {
        var segments = path
            .Split('/', StringSplitOptions.RemoveEmptyEntries)
            .Select(Uri.UnescapeDataString)
            .Select(segment => Uri.EscapeDataString(segment.Trim()))
            .ToArray();

        return "/" + string.Join('/', segments);
    }

    private static string NormalizeText(string? value) =>
        (value ?? string.Empty).Trim().ToUpperInvariant();

    private static IEnumerable<KeyValuePair<string, string>> ParseQuery(string query)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            yield break;
        }

        foreach (var component in query.TrimStart('?')
                     .Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = component.IndexOf('=');
            if (separator < 0)
            {
                yield return new KeyValuePair<string, string>(
                    Uri.UnescapeDataString(component),
                    string.Empty);
                continue;
            }

            yield return new KeyValuePair<string, string>(
                Uri.UnescapeDataString(component[..separator]),
                Uri.UnescapeDataString(component[(separator + 1)..]));
        }
    }
}
