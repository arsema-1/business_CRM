import { Request, Response } from "express";
import { prisma } from "../config/db";

// ─── Accounts dashboard ──────────────────────────────────────────────────────
// Dedicated endpoint for the ACCOUNTS role. Returns:
//   - Revenue summary (total, this month, last month, draft/pending value)
//   - Monthly revenue for the past 12 months
//   - Top 10 customers by confirmed revenue
//   - Recent confirmed orders with line totals
//   - Recent draft orders with their pending value

export async function getAccountsDashboard(_req: Request, res: Response) {
  const now = new Date();
  const startOfMonth  = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLast   = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLast     = new Date(now.getFullYear(), now.getMonth(), 1);
  const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

  // Fetch all confirmed challan items (for revenue aggregations)
  // and all draft challan items (for pending value)
  const [confirmedItems, draftItems, confirmedChallans, draftChallans] = await Promise.all([
    prisma.challanItem.findMany({
      where: { challan: { status: "CONFIRMED" } },
      select: {
        quantity: true,
        unitPriceSnapshot: true,
        challan: {
          select: {
            id: true,
            challanNumber: true,
            createdAt: true,
            customerId: true,
            customer: { select: { id: true, name: true, businessName: true } },
          },
        },
      },
    }),
    prisma.challanItem.findMany({
      where: { challan: { status: "DRAFT" } },
      select: { quantity: true, unitPriceSnapshot: true },
    }),
    prisma.challan.findMany({
      where: { status: "CONFIRMED" },
      orderBy: { createdAt: "desc" },
      take: 15,
      include: {
        customer: { select: { id: true, name: true, businessName: true } },
        items: { select: { quantity: true, unitPriceSnapshot: true } },
      },
    }),
    prisma.challan.findMany({
      where: { status: "DRAFT" },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: {
        customer: { select: { id: true, name: true, businessName: true } },
        items: { select: { quantity: true, unitPriceSnapshot: true } },
      },
    }),
  ]);

  // ── Revenue summary ────────────────────────────────────────────────────────
  const lineValue = (qty: number, price: unknown) => qty * Number(price);

  const revenueTotal = confirmedItems.reduce(
    (s, i) => s + lineValue(i.quantity, i.unitPriceSnapshot), 0
  );
  const revenueThisMonth = confirmedItems
    .filter((i) => new Date(i.challan.createdAt) >= startOfMonth)
    .reduce((s, i) => s + lineValue(i.quantity, i.unitPriceSnapshot), 0);
  const revenueLastMonth = confirmedItems
    .filter((i) => {
      const d = new Date(i.challan.createdAt);
      return d >= startOfLast && d < endOfLast;
    })
    .reduce((s, i) => s + lineValue(i.quantity, i.unitPriceSnapshot), 0);
  const draftValue = draftItems.reduce(
    (s, i) => s + lineValue(i.quantity, i.unitPriceSnapshot), 0
  );

  // ── Monthly breakdown — last 12 months ────────────────────────────────────
  const monthlyMap: Record<string, number> = {};
  for (let m = 0; m < 12; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthlyMap[key] = 0;
  }
  confirmedItems
    .filter((i) => new Date(i.challan.createdAt) >= twelveMonthsAgo)
    .forEach((i) => {
      const d = new Date(i.challan.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (key in monthlyMap) monthlyMap[key] += lineValue(i.quantity, i.unitPriceSnapshot);
    });
  const monthlyRevenue = Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, revenue]) => ({ month, revenue }));

  // ── Top customers by confirmed revenue ────────────────────────────────────
  const customerRevMap: Record<string, { id: string; name: string; businessName?: string; revenue: number }> = {};
  confirmedItems.forEach((i) => {
    const c = i.challan.customer;
    if (!customerRevMap[c.id]) {
      customerRevMap[c.id] = { id: c.id, name: c.name, businessName: c.businessName ?? undefined, revenue: 0 };
    }
    customerRevMap[c.id].revenue += lineValue(i.quantity, i.unitPriceSnapshot);
  });
  const topCustomers = Object.values(customerRevMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  // ── Annotate challan lists with their total value ─────────────────────────
  const withTotal = (challans: typeof confirmedChallans) =>
    challans.map((c) => ({
      id: c.id,
      challanNumber: c.challanNumber,
      createdAt: c.createdAt,
      customer: c.customer,
      total: c.items.reduce((s, i) => s + lineValue(i.quantity, i.unitPriceSnapshot), 0),
      itemCount: c.items.length,
    }));

  res.json({
    success: true,
    data: {
      summary: {
        revenueTotal,
        revenueThisMonth,
        revenueLastMonth,
        draftValue,
      },
      monthlyRevenue,
      topCustomers,
      recentConfirmed: withTotal(confirmedChallans),
      recentDraft: withTotal(draftChallans as any),
    },
  });
}

export async function getDashboard(_req: Request, res: Response) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    totalCustomers,
    leadCount,
    activeCount,
    totalOrders,
    draftOrders,
    confirmedOrders,
    recentCustomers,
    recentOrders,
    overdueFollowUps,
    dueTodayFollowUps,
    revenueAll,
    revenueMonth,
  ] = await Promise.all([
    prisma.customer.count(),
    prisma.customer.count({ where: { status: "LEAD" } }),
    prisma.customer.count({ where: { status: "ACTIVE" } }),
    prisma.challan.count(),
    prisma.challan.count({ where: { status: "DRAFT" } }),
    prisma.challan.count({ where: { status: "CONFIRMED" } }),
    prisma.customer.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, name: true, businessName: true, status: true, createdAt: true },
    }),
    prisma.challan.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { customer: { select: { id: true, name: true } } },
    }),
    // Customers whose follow-up date is in the past (overdue)
    prisma.customer.findMany({
      where: {
        followUpDate: { lt: startOfToday },
        status: { not: "INACTIVE" },
      },
      orderBy: { followUpDate: "asc" },
      take: 10,
      select: { id: true, name: true, followUpDate: true, status: true },
    }),
    // Customers whose follow-up date is today
    prisma.customer.findMany({
      where: {
        followUpDate: { gte: startOfToday, lt: endOfToday },
        status: { not: "INACTIVE" },
      },
      orderBy: { followUpDate: "asc" },
      take: 10,
      select: { id: true, name: true, followUpDate: true, status: true },
    }),
    // Total revenue from all confirmed challans
    prisma.challanItem.aggregate({
      _sum: { quantity: true },
      where: { challan: { status: "CONFIRMED" } },
    }).then(async () => {
      // We need sum of (unitPriceSnapshot * quantity) — no direct Prisma aggregate for multiplication
      // so use groupBy + raw calculation
      const items = await prisma.challanItem.findMany({
        where: { challan: { status: "CONFIRMED" } },
        select: { quantity: true, unitPriceSnapshot: true },
      });
      return items.reduce((sum, i) => sum + Number(i.unitPriceSnapshot) * i.quantity, 0);
    }),
    // Revenue this month
    prisma.challanItem.findMany({
      where: { challan: { status: "CONFIRMED", createdAt: { gte: startOfMonth } } },
      select: { quantity: true, unitPriceSnapshot: true },
    }).then((items) =>
      items.reduce((sum, i) => sum + Number(i.unitPriceSnapshot) * i.quantity, 0)
    ),
  ]);

  res.json({
    success: true,
    data: {
      customers: { total: totalCustomers, leads: leadCount, active: activeCount },
      orders: { total: totalOrders, draft: draftOrders, confirmed: confirmedOrders },
      revenue: { total: revenueAll, thisMonth: revenueMonth },
      followUps: { overdue: overdueFollowUps, dueToday: dueTodayFollowUps },
      recentCustomers,
      recentOrders,
    },
  });
}
