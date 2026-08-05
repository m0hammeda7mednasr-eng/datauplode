using System.Security.Cryptography;
using System.Text;

namespace Dabdoob.Sync.Api.Security;

public sealed class ShopifyWebhookVerifier(IConfiguration configuration)
{
    private readonly byte[] _secret = Encoding.UTF8.GetBytes(
        configuration["Shopify:WebhookSecret"]
        ?? throw new InvalidOperationException("Shopify:WebhookSecret is required."));

    public bool IsValid(ReadOnlySpan<byte> body, string suppliedHmac)
    {
        if (string.IsNullOrWhiteSpace(suppliedHmac))
        {
            return false;
        }

        byte[] supplied;
        try
        {
            supplied = Convert.FromBase64String(suppliedHmac);
        }
        catch (FormatException)
        {
            return false;
        }

        using var hmac = new HMACSHA256(_secret);
        var computed = hmac.ComputeHash(body.ToArray());
        return supplied.Length == computed.Length
            && CryptographicOperations.FixedTimeEquals(supplied, computed);
    }
}
