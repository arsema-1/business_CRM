import { Request, Response } from "express";
import { prisma } from "../config/db";
import { ApiError } from "../utils/ApiError";
import { sanitizeBody } from "../utils/sanitize";
import { writeAuditLog } from "../utils/audit";

const CUSTOMER_TYPES = ["RETAIL", "WHOLESALE", "DISTRIBUTOR"];
const CUSTOMER_STATUSES = ["LEAD", "ACTIVE", "INACTIVE"];

export async function listCustomers(req: Request, res: Response) {
  const page = Math.max(parseInt((req.query.page as string) || "1", 10), 1);
  const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "20", 10), 1), 100);
  const search = (req.query.search as string) || "";
  const status = req.query.status as string | undefined;
  const customerType = req.query.customerType as string | undefined;

  const where: any = {};
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { mobile: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { businessName: { contains: search, mode: "insensitive" } },
    ];
  }
  if (status && CUSTOMER_STATUSES.includes(status)) where.status = status;
  if (customerType && CUSTOMER_TYPES.includes(customerType)) where.customerType = customerType;

  const [total, data] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  res.json({
    success: true,
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function getCustomer(req: Request, res: Response) {
  const customer = await prisma.customer.findUnique({
    where: { id: req.params.id },
    include: { followUps: { orderBy: { createdAt: "desc" } }, challans: { orderBy: { createdAt: "desc" } } },
  });
  if (!customer) throw new ApiError(404, "Customer not found");
  res.json({ success: true, data: customer });
}

function validateCustomerBody(body: any, partial = false) {
  const errors: string[] = [];
  if (!partial || body.name !== undefined) {
    if (!body.name || typeof body.name !== "string") errors.push("name is required");
  }
  if (!partial || body.mobile !== undefined) {
    if (!body.mobile || typeof body.mobile !== "string") errors.push("mobile is required");
  }
  if (body.customerType && !CUSTOMER_TYPES.includes(body.customerType)) {
    errors.push(`customerType must be one of ${CUSTOMER_TYPES.join(", ")}`);
  }
  if (body.status && !CUSTOMER_STATUSES.includes(body.status)) {
    errors.push(`status must be one of ${CUSTOMER_STATUSES.join(", ")}`);
  }
  if (errors.length) throw new ApiError(400, "Validation failed", errors);
}

export async function createCustomer(req: Request, res: Response) {
  sanitizeBody(req.body, ["name", "mobile", "email", "businessName", "gstNumber", "address", "notes"]);
  validateCustomerBody(req.body);
  const { name, mobile, email, businessName, gstNumber, customerType, address, status, followUpDate, notes } = req.body;

  const customer = await prisma.customer.create({
    data: {
      name, mobile, email, businessName, gstNumber,
      customerType: customerType || undefined,
      address, status: status || undefined,
      followUpDate: followUpDate ? new Date(followUpDate) : undefined,
      notes, createdById: req.user?.id,
    },
  });

  await writeAuditLog(req, "CUSTOMER_CREATED", "Customer", customer.id, `Created customer ${customer.name}`);
  res.status(201).json({ success: true, data: customer });
}

export async function updateCustomer(req: Request, res: Response) {
  sanitizeBody(req.body, ["name", "mobile", "email", "businessName", "gstNumber", "address", "notes"]);
  validateCustomerBody(req.body, true);
  const existing = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError(404, "Customer not found");

  const { name, mobile, email, businessName, gstNumber, customerType, address, status, followUpDate, notes } = req.body;

  const customer = await prisma.customer.update({
    where: { id: req.params.id },
    data: { name, mobile, email, businessName, gstNumber, customerType, address, status,
      followUpDate: followUpDate ? new Date(followUpDate) : undefined, notes },
  });

  await writeAuditLog(req, "CUSTOMER_UPDATED", "Customer", customer.id, `Updated customer ${customer.name}`);
  res.json({ success: true, data: customer });
}

export async function addFollowUp(req: Request, res: Response) {
  const note = typeof req.body.note === "string" ? req.body.note.replace(/<[^>]*>/g, "").trim() : "";
  if (!note) throw new ApiError(400, "note is required");

  const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!customer) throw new ApiError(404, "Customer not found");

  const followUp = await prisma.followUp.create({
    data: { customerId: req.params.id, note, createdById: req.user?.id },
  });

  await writeAuditLog(req, "FOLLOWUP_ADDED", "Customer", req.params.id, `Follow-up added to ${customer.name}`);
  res.status(201).json({ success: true, data: followUp });
}
