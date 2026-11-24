import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "./config/db";

async function main() {
  const password = process.env.SEED_PASSWORD || "Password@123";
  const passwordHash = await bcrypt.hash(password, 12);

  const roles: { name: string; email: string; role: "ADMIN" | "SALES" | "WAREHOUSE" | "ACCOUNTS" }[] = [
    { name: "Admin User", email: "admin@demo.com", role: "ADMIN" },
    { name: "Sales User", email: "sales@demo.com", role: "SALES" },
    { name: "Warehouse User", email: "warehouse@demo.com", role: "WAREHOUSE" },
    { name: "Accounts User", email: "accounts@demo.com", role: "ACCOUNTS" },
  ];

  for (const r of roles) {
    await prisma.user.upsert({
      where: { email: r.email },
      update: { isActive: true, emailVerifiedAt: new Date() },
      create: {
        name: r.name,
        email: r.email,
        passwordHash,
        role: r.role,
        isActive: true,
        emailVerifiedAt: new Date(),
      },
    });
  }
  console.log(`Seeded ${roles.length} users (password read from SEED_PASSWORD env var).`);

  const admin = await prisma.user.findUnique({ where: { email: "admin@demo.com" } });

  const customer = await prisma.customer.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Ramesh Traders",
      mobile: "9876543210",
      email: "ramesh@traders.com",
      businessName: "Ramesh Traders Pvt Ltd",
      customerType: "WHOLESALE",
      status: "ACTIVE",
      address: "MG Road, Jalandhar, Punjab",
      createdById: admin?.id,
    },
  });

  const product1 = await prisma.product.upsert({
    where: { sku: "SKU-001" },
    update: {},
    create: {
      name: "Steel Rod 12mm",
      sku: "SKU-001",
      category: "Construction Material",
      unitPrice: 650.0,
      currentStock: 500,
      minStockAlert: 50,
      location: "Warehouse A",
    },
  });

  await prisma.product.upsert({
    where: { sku: "SKU-002" },
    update: {},
    create: {
      name: "Cement Bag 50kg",
      sku: "SKU-002",
      category: "Construction Material",
      unitPrice: 420.0,
      currentStock: 200,
      minStockAlert: 30,
      location: "Warehouse B",
    },
  });

  console.log(`Seeded demo customer '${customer.name}' and 2 demo products.`);
  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
