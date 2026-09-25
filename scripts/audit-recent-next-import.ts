import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const products = await prisma.sourceProduct.findMany({
    where: {
      createdAt: { gte: new Date("2026-09-25T12:00:00Z") },
      url: { contains: "next.ae" },
    },
    select: {
      id: true,
      url: true,
      title: true,
      price: true,
      currency: true,
      createdAt: true,
      shopifyProduct: { select: { shopifyId: true, status: true } },
      variants: { select: { size: true, color: true, available: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const malformedTitle = products.filter((product) =>
    /<script|personalisation|metadata|attention required/i.test(product.title),
  );
  const singleVariant = products.filter((product) => product.variants.length < 2);
  const bad = products.filter(
    (product) => malformedTitle.includes(product) || singleVariant.includes(product),
  );

  console.log(
    JSON.stringify(
      {
        total: products.length,
        badCount: bad.length,
        malformedTitle: malformedTitle.length,
        singleVariant: singleVariant.length,
        samples: bad.slice(0, 30),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
