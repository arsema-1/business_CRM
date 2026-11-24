import { Request, Response } from "express";
import { prisma } from "../config/db";
import { ApiError } from "../utils/ApiError";
import { writeAuditLog } from "../utils/audit";

async function generateChallanNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `CH-${year}-`;
  const count = await prisma.challan.count({ where: { challanNumber: { startsWith: prefix } } });
  const next = (count + 1).toString().padStart(4, "0");
  return `${prefix}${next}`;
}

export async function listChallans(req: Request, res: Response) {
  const page = Math.max(parseInt((req.query.page as string) || "1", 10), 1);
  const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "20", 10), 1), 100);
  const status = req.query.status as string | undefined;
  const customerId = req.query.customerId as string | undefined;
  const search = (req.query.search as string) || "";

  const where: any = {};
  if (status) where.status = status;
  if (customerId) where.customerId = customerId;
  if (search) {
    where.OR = [
      { challanNumber: { contains: search, mode: "insensitive" } },
      { customer: { name: { contains: search, mode: "insensitive" } } },
    ];
  }

  const [total, data] = await Promise.all([
    prisma.challan.count({ where }),
    prisma.challan.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: { customer: { select: { id: true, name: true, businessName: true } }, items: true },
    }),
  ]);

  res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

export async function getChallan(req: Request, res: Response) {
  const challan = await prisma.challan.findUnique({
    where: { id: req.params.id },
    include: { customer: true, items: { include: { product: true } } },
  });
  if (!challan) throw new ApiError(404, "Challan not found");
  res.json({ success: true, data: challan });
}

interface IncomingItem {
  productId: string;
  quantity: number;
}

export async function createChallan(req: Request, res: Response) {
  const { customerId, items } = req.body as { customerId?: string; items?: IncomingItem[] };

  if (!customerId) throw new ApiError(400, "customerId is required");
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, "items must be a non-empty array of { productId, quantity }");
  }
  for (const item of items) {
    if (!item.productId || !item.quantity || item.quantity <= 0) {
      throw new ApiError(400, "Each item requires a valid productId and a positive quantity");
    }
  }

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new ApiError(404, "Customer not found");

  const productIds = items.map((i) => i.productId);
  const products = await prisma.product.findMany({ where: { id: { in: productIds } } });
  if (products.length !== productIds.length) {
    throw new ApiError(404, "One or more products were not found");
  }

  const challanNumber = await generateChallanNumber();
  const totalQuantity = items.reduce((sum, i) => sum + Number(i.quantity), 0);

  const challan = await prisma.challan.create({
    data: {
      challanNumber,
      customerId,
      totalQuantity,
      status: "DRAFT",
      createdById: req.user?.id,
      items: {
        create: items.map((item) => {
          const product = products.find((p: any) => p.id === item.productId)!;
          return {
            productId: product.id,
            // Snapshot product data at the time of challan creation, as required by the spec
            productNameSnapshot: product.name,
            productSkuSnapshot: product.sku,
            unitPriceSnapshot: product.unitPrice,
            quantity: item.quantity,
          };
        }),
      },
    },
    include: { items: true, customer: true },
  });

  await writeAuditLog(
    req,
    "CHALLAN_CREATED",
    "Challan",
    challan.id,
    `Created challan ${challan.challanNumber} for ${customer.name} with ${totalQuantity} item(s) in DRAFT`
  );

  res.status(201).json({ success: true, data: challan });
}

export async function confirmChallan(req: Request, res: Response) {
  const result = await prisma.$transaction(async (tx: any) => {
    const challan = await tx.challan.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!challan) throw new ApiError(404, "Challan not found");
    if (challan.status !== "DRAFT") {
      throw new ApiError(400, `Only DRAFT challans can be confirmed. Current status: ${challan.status}`);
    }

    // Validate stock availability for every line item before making any changes
    for (const item of challan.items) {
      const product = await tx.product.findUnique({ where: { id: item.productId } });
      if (!product) throw new ApiError(404, `Product ${item.productSkuSnapshot} no longer exists`);
      if (product.currentStock < item.quantity) {
        throw new ApiError(
          400,
          `Insufficient stock for ${product.name} (${product.sku}). Available: ${product.currentStock}, required: ${item.quantity}.`
        );
      }
    }

    // All checks passed - deduct stock and log each movement
    for (const item of challan.items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { currentStock: { decrement: item.quantity } },
      });
      await tx.stockMovement.create({
        data: {
          productId: item.productId,
          quantityChanged: item.quantity,
          movementType: "OUT",
          reason: `Sales challan ${challan.challanNumber} confirmed`,
          createdById: req.user?.id,
        },
      });
    }

    const updated = await tx.challan.update({
      where: { id: req.params.id },
      data: { status: "CONFIRMED" },
      include: { items: true, customer: true },
    });

    return updated;
  });

  await writeAuditLog(
    req,
    "CHALLAN_CONFIRMED",
    "Challan",
    result.id,
    `Confirmed challan ${result.challanNumber}; stock deducted for ${result.items.length} line item(s)`
  );

  res.json({ success: true, data: result });
}

export async function cancelChallan(req: Request, res: Response) {
  const challan = await prisma.challan.findUnique({ where: { id: req.params.id } });
  if (!challan) throw new ApiError(404, "Challan not found");
  if (challan.status === "CANCELLED") throw new ApiError(400, "Challan is already cancelled");

  const result = await prisma.$transaction(async (tx: any) => {
    // If it was already confirmed (stock deducted), restock on cancellation
    if (challan.status === "CONFIRMED") {
      const items = await tx.challanItem.findMany({ where: { challanId: challan.id } });
      for (const item of items) {
        await tx.product.update({
          where: { id: item.productId },
          data: { currentStock: { increment: item.quantity } },
        });
        await tx.stockMovement.create({
          data: {
            productId: item.productId,
            quantityChanged: item.quantity,
            movementType: "IN",
            reason: `Sales challan ${challan.challanNumber} cancelled - stock reverted`,
            createdById: req.user?.id,
          },
        });
      }
    }

    return tx.challan.update({
      where: { id: challan.id },
      data: { status: "CANCELLED" },
      include: { items: true, customer: true },
    });
  });

  await writeAuditLog(
    req,
    "CHALLAN_CANCELLED",
    "Challan",
    result.id,
    `Cancelled challan ${result.challanNumber} (was ${challan.status}) for ${result.customer.name}`
  );

  res.json({ success: true, data: result });
}
