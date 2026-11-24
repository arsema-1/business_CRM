// Temporary verification helper for task 2 (audit/logging). Deleted afterwards.
import bcrypt from "bcryptjs";
import { prisma } from "./config/db";
import { decryptField } from "./utils/logCrypto";

const ADMIN = "auditadmin@local.test";
const SALES = "auditsales@local.test";
const PASS_ADMIN = "AdminPass!2345";
const PASS_SALES = "SalesPass!2345";

async function main() {
  const cmd = process.argv[2];

  if (cmd === "create") {
    await prisma.user.deleteMany({ where: { email: { in: [ADMIN, SALES] } } });
    const admin = await prisma.user.create({
      data: {
        name: "Audit Admin",
        email: ADMIN,
        passwordHash: await bcrypt.hash(PASS_ADMIN, 10),
        role: "ADMIN",
        isActive: true,
        emailVerifiedAt: new Date(),
      },
    });
    const sales = await prisma.user.create({
      data: {
        name: "Audit Sales",
        email: SALES,
        passwordHash: await bcrypt.hash(PASS_SALES, 10),
        role: "SALES",
        isActive: true,
        emailVerifiedAt: new Date(),
        approvedAt: new Date(),
        selfRegistered: true,
      },
    });
    const customer = await prisma.customer.create({
      data: { name: "Audit Fixture Co", mobile: "9000000001", createdById: admin.id },
    });
    console.log(JSON.stringify({ adminId: admin.id, salesId: sales.id, customerId: customer.id }));
    return;
  }

  if (cmd === "dump") {
    const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 14 });
    for (const r of rows) {
      console.log(
        `${r.createdAt.toISOString()} | ${r.severity.padEnd(8)} | ${String(r.userEmail).padEnd(24)} | ${r.action.padEnd(24)} | ${r.path ?? "-"} | ${decryptField(r.detail) ?? ""}`
      );
    }
    return;
  }

  if (cmd === "cleanup") {
    const start = new Date(process.argv[3]);
    const users = await prisma.user.findMany({
      where: { email: { in: [ADMIN, SALES, "auditnothere@local.test"] } },
      select: { id: true, email: true },
    });
    const userIds = users.map((u) => u.id);

    const products = await prisma.product.findMany({ where: { sku: { startsWith: "AUDIT-" } }, select: { id: true } });
    const productIds = products.map((p) => p.id);
    const challans = await prisma.challan.findMany({
      where: { OR: [{ createdById: { in: userIds } }, { challanNumber: { startsWith: "CH-" } }] },
      select: { id: true },
    });
    const challanIds = challans.map((c) => c.id);

    // Audit rows are append-only (a database trigger rejects DELETE), so the
    // fixtures' log entries stay behind on purpose — deleting them would defeat
    // the tamper-evidence this helper exists to demonstrate.
    await prisma.challanItem.deleteMany({ where: { challanId: { in: challanIds } } });
    await prisma.challan.deleteMany({ where: { id: { in: challanIds } } });
    await prisma.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.challanItem.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.followUp.deleteMany({ where: { customer: { name: "Audit Fixture Co" } } });
    await prisma.customer.deleteMany({ where: { name: "Audit Fixture Co" } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });

    console.log(`cleanup: users=${users.length} products=${productIds.length} challans=${challanIds.length}`);
  }
}

main().finally(() => prisma.$disconnect());
