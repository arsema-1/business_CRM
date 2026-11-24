import { Request, Response } from "express";
import { prisma } from "../config/db";
import { ApiError } from "../utils/ApiError";
import { writeAuditLog } from "../utils/audit";

export async function listProducts(req: Request, res: Response) {
  const page = Math.max(parseInt((req.query.page as string) || "1", 10), 1);
  const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "20", 10), 1), 100);
  const search = (req.query.search as string) || "";
  const lowStockOnly = req.query.lowStock === "true";

  const where: any = {};
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { sku: { contains: search, mode: "insensitive" } },
      { category: { contains: search, mode: "insensitive" } },
    ];
  }

  const [total, allMatching] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      skip: lowStockOnly ? undefined : (page - 1) * limit,
      take: lowStockOnly ? undefined : limit,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  let data = allMatching;
  if (lowStockOnly) {
    data = allMatching.filter((p: any) => p.currentStock <= p.minStockAlert);
  }

  res.json({
    success: true,
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function getProduct(req: Request, res: Response) {
  const product = await prisma.product.findUnique({
    where: { id: req.params.id },
    include: { stockMovements: { orderBy: { createdAt: "desc" }, take: 50 } },
  });
  if (!product) throw new ApiError(404, "Product not found");
  res.json({ success: true, data: product });
}

function validateProductBody(body: any, partial = false) {
  const errors: string[] = [];
  if (!partial || body.name !== undefined) {
    if (!body.name) errors.push("name is required");
  }
  if (!partial || body.sku !== undefined) {
    if (!body.sku) errors.push("sku is required");
  }
  if (!partial || body.unitPrice !== undefined) {
    if (body.unitPrice === undefined || isNaN(Number(body.unitPrice))) errors.push("unitPrice must be a number");
  }
  if (body.currentStock !== undefined && isNaN(Number(body.currentStock))) {
    errors.push("currentStock must be a number");
  }
  if (body.minStockAlert !== undefined && isNaN(Number(body.minStockAlert))) {
    errors.push("minStockAlert must be a number");
  }
  if (errors.length) throw new ApiError(400, "Validation failed", errors);
}

export async function createProduct(req: Request, res: Response) {
  validateProductBody(req.body);
  const { name, sku, category, unitPrice, currentStock, minStockAlert, location } = req.body;

  const product = await prisma.product.create({
    data: {
      name,
      sku,
      category,
      unitPrice,
      currentStock: currentStock ?? 0,
      minStockAlert: minStockAlert ?? 0,
      location,
    },
  });

  // If created with initial stock, log it as an IN movement
  if (currentStock && Number(currentStock) > 0) {
    await prisma.stockMovement.create({
      data: {
        productId: product.id,
        quantityChanged: Number(currentStock),
        movementType: "IN",
        reason: "Initial stock on product creation",
        createdById: req.user?.id,
      },
    });
  }

  await writeAuditLog(
    req,
    "PRODUCT_CREATED",
    "Product",
    product.id,
    `Created product ${product.name} (${product.sku}) with ${product.currentStock} in stock`
  );

  res.status(201).json({ success: true, data: product });
}

export async function updateProduct(req: Request, res: Response) {
  validateProductBody(req.body, true);
  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError(404, "Product not found");

  const { name, sku, category, unitPrice, minStockAlert, location } = req.body;
  // Note: currentStock is intentionally NOT editable here directly -
  // it must change only through the /stock movement endpoint so the log stays accurate.

  const product = await prisma.product.update({
    where: { id: req.params.id },
    data: { name, sku, category, unitPrice, minStockAlert, location },
  });

  const changed = ["name", "sku", "category", "unitPrice", "minStockAlert", "location"]
    .filter((field) => (req.body as Record<string, unknown>)[field] !== undefined)
    .join(", ") || "no fields";
  await writeAuditLog(
    req,
    "PRODUCT_UPDATED",
    "Product",
    product.id,
    `Updated product ${product.name} (${product.sku}); changed: ${changed}`
  );

  res.json({ success: true, data: product });
}

export async function listStockMovements(req: Request, res: Response) {
  const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "20", 10), 1), 100);
  const movements = await prisma.stockMovement.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      product: { select: { id: true, name: true, sku: true } },
    },
  });
  res.json({ success: true, data: movements });
}

export async function recordStockMovement(req: Request, res: Response) {
  const { quantity, movementType, reason } = req.body as {
    quantity?: number;
    movementType?: "IN" | "OUT";
    reason?: string;
  };

  if (!quantity || Number(quantity) <= 0) throw new ApiError(400, "quantity must be a positive number");
  if (!movementType || !["IN", "OUT"].includes(movementType)) {
    throw new ApiError(400, "movementType must be IN or OUT");
  }
  if (!reason) throw new ApiError(400, "reason is required");

  const result = await prisma.$transaction(async (tx: any) => {
    const product = await tx.product.findUnique({ where: { id: req.params.id } });
    if (!product) throw new ApiError(404, "Product not found");

    const delta = movementType === "IN" ? Number(quantity) : -Number(quantity);
    const newStock = product.currentStock + delta;

    if (newStock < 0) {
      throw new ApiError(400, `Insufficient stock. Current stock is ${product.currentStock}, cannot remove ${quantity}.`);
    }

    const updated = await tx.product.update({
      where: { id: req.params.id },
      data: { currentStock: newStock },
    });

    const movement = await tx.stockMovement.create({
      data: {
        productId: req.params.id,
        quantityChanged: Number(quantity),
        movementType,
        reason,
        createdById: req.user?.id,
      },
    });

    return { product: updated, movement };
  });

  await writeAuditLog(
    req,
    "STOCK_MOVED",
    "Product",
    result.product.id,
    `${movementType} ${quantity} for ${result.product.name} (${result.product.sku}); stock is now ${result.product.currentStock}. Reason: ${reason}`
  );

  res.status(201).json({ success: true, data: result });
}
