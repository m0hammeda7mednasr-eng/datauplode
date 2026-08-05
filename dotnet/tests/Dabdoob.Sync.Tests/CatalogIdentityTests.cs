using Dabdoob.Sync.Application.Catalog;

namespace Dabdoob.Sync.Tests;

public sealed class CatalogIdentityTests
{
    [Fact]
    public void CanonicalizeSourceUrl_RemovesTrackingAndNormalizesOrder()
    {
        var actual = CatalogIdentity.CanonicalizeSourceUrl(
            "http://EXAMPLE.com:80/products/kids%20shoe/?utm_source=ads&size=28&color=Blue&fbclid=123");

        Assert.Equal(
            "https://example.com/products/kids%20shoe?color=Blue&size=28",
            actual);
    }

    [Fact]
    public void CanonicalizeSourceUrl_PreservesFragmentForVariantIdentity()
    {
        var actual = CatalogIdentity.CanonicalizeSourceUrl(
            "https://www.next.ae/en/style/st123#blue");

        Assert.Equal("https://www.next.ae/en/style/st123#blue", actual);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-url")]
    [InlineData("ftp://example.com/product")]
    public void CanonicalizeSourceUrl_RejectsInvalidSources(string value)
    {
        Assert.ThrowsAny<ArgumentException>(() =>
            CatalogIdentity.CanonicalizeSourceUrl(value));
    }

    [Fact]
    public void CreateRowFingerprint_IsStableAcrossWhitespaceAndCase()
    {
        const string source = "https://example.com/product/1";

        var first = CatalogIdentity.CreateRowFingerprint(
            source,
            1.25m,
            " Kids Shoes ",
            " sku-100 ");
        var second = CatalogIdentity.CreateRowFingerprint(
            source,
            1.2500m,
            "kids shoes",
            "SKU-100");

        Assert.Equal(first, second);
    }

    [Fact]
    public void CreateRowFingerprint_ChangesWhenMeaningfulDataChanges()
    {
        const string source = "https://example.com/product/1";

        var baseline = CatalogIdentity.CreateRowFingerprint(source, 1.25m, "Kids", "SKU-1");
        var changedPrice = CatalogIdentity.CreateRowFingerprint(source, 1.30m, "Kids", "SKU-1");
        var changedSku = CatalogIdentity.CreateRowFingerprint(source, 1.25m, "Kids", "SKU-2");

        Assert.NotEqual(baseline, changedPrice);
        Assert.NotEqual(baseline, changedSku);
    }
}
