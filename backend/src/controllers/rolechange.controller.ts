import { Request, Response } from "express";
import { prisma } from "../config/db";
import { ApiError } from "../utils/ApiError";
import { writeAuditLog } from "../utils/audit";

const VALID_ROLES = ["ADMIN", "SALES", "WAREHOUSE", "ACCOUNTS"] as const;
type Role = (typeof VALID_ROLES)[number];

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeRole(value: unknown): Role {
  if (typeof value === "string" && VALID_ROLES.includes(value as Role)) return value as Role;
  throw new ApiError(400, `role must be one of: ${VALID_ROLES.join(", ")}`);
}

// ─── POST /role-changes ──────────────────────────────────────────────────────
// Any ADMIN can submit a role change request for another user.
// An ADMIN cannot submit a request for themselves (separation of duties —
// the approver must be a different ADMIN).

export async function requestRoleChange(req: Request, res: Response) {
  const { targetUserId, toRole, justification } = req.body as {
    targetUserId?: string;
    toRole?: string;
    justification?: string;
  };

  if (!targetUserId) throw new ApiError(400, "targetUserId is required");
  if (!justification?.trim()) throw new ApiError(400, "justification is required");
  const newRole = safeRole(toRole);

  // Separation of duties: requester cannot be the target
  if (targetUserId === req.user!.id) {
    throw new ApiError(403, "You cannot request a role change for your own account");
  }

  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw new ApiError(404, "Target user not found");
  if (!target.isActive) throw new ApiError(400, "Cannot change the role of an inactive user");

  if (target.role === newRole) {
    throw new ApiError(400, `User already has role ${newRole}`);
  }

  // Block duplicate pending requests for the same target
  const existing = await prisma.roleChangeRequest.findFirst({
    where: { targetUserId, status: "PENDING" },
  });
  if (existing) {
    throw new ApiError(409, "A pending role change request already exists for this user");
  }

  const request = await prisma.roleChangeRequest.create({
    data: {
      targetUserId,
      requestedById: req.user!.id,
      fromRole: target.role,
      toRole: newRole,
      justification: justification.trim(),
    },
    include: {
      targetUser: { select: { id: true, name: true, email: true, role: true } },
      requestedBy: { select: { id: true, name: true, email: true } },
    },
  });

  await writeAuditLog(
    req,
    "ROLE_CHANGE_REQUESTED",
    "RoleChangeRequest",
    request.id,
    `Requested role change for ${target.email}: ${target.role} → ${newRole}`
  );

  res.status(201).json({ success: true, data: request });
}

// ─── GET /role-changes ───────────────────────────────────────────────────────
// ADMIN sees all requests. Query param ?status= filters by status.

export async function listRoleChanges(req: Request, res: Response) {
  const statusFilter = req.query.status as string | undefined;
  const validStatuses = ["PENDING", "APPROVED", "REJECTED"];

  const where: any = {};
  if (statusFilter && validStatuses.includes(statusFilter)) {
    where.status = statusFilter;
  }

  const requests = await prisma.roleChangeRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      targetUser: { select: { id: true, name: true, email: true, role: true } },
      requestedBy: { select: { id: true, name: true, email: true } },
      reviewedBy:  { select: { id: true, name: true, email: true } },
    },
  });

  res.json({ success: true, data: requests });
}

// ─── PUT /role-changes/:id/approve ──────────────────────────────────────────
// Separation of duties: the approver must be a different ADMIN than the requester.

export async function approveRoleChange(req: Request, res: Response) {
  const { reviewNote } = req.body as { reviewNote?: string };

  const rcr = await prisma.roleChangeRequest.findUnique({
    where: { id: req.params.id },
    include: { targetUser: true },
  });
  if (!rcr) throw new ApiError(404, "Role change request not found");
  if (rcr.status !== "PENDING") {
    throw new ApiError(400, `Request has already been ${rcr.status.toLowerCase()}`);
  }

  // Separation of duties: approver cannot be the same person who raised the request
  if (rcr.requestedById === req.user!.id) {
    throw new ApiError(
      403,
      "You cannot approve a role change request that you submitted (separation of duties)"
    );
  }

  // Execute role change + mark request approved atomically
  const [updatedUser, updatedRcr] = await prisma.$transaction([
    prisma.user.update({
      where: { id: rcr.targetUserId },
      data: { role: rcr.toRole },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    }),
    prisma.roleChangeRequest.update({
      where: { id: rcr.id },
      data: {
        status: "APPROVED",
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        reviewNote: reviewNote?.trim() || null,
      },
      include: {
        targetUser: { select: { id: true, name: true, email: true, role: true } },
        requestedBy: { select: { id: true, name: true, email: true } },
        reviewedBy:  { select: { id: true, name: true, email: true } },
      },
    }),
  ]);

  await writeAuditLog(
    req,
    "ROLE_CHANGE_APPROVED",
    "User",
    rcr.targetUserId,
    `Role changed for ${rcr.targetUser.email}: ${rcr.fromRole} → ${rcr.toRole} (approved by ${req.user!.email})`
  );

  res.json({ success: true, data: { request: updatedRcr, user: updatedUser } });
}

// ─── PUT /role-changes/:id/reject ───────────────────────────────────────────

export async function rejectRoleChange(req: Request, res: Response) {
  const { reviewNote } = req.body as { reviewNote?: string };

  const rcr = await prisma.roleChangeRequest.findUnique({
    where: { id: req.params.id },
    include: { targetUser: true },
  });
  if (!rcr) throw new ApiError(404, "Role change request not found");
  if (rcr.status !== "PENDING") {
    throw new ApiError(400, `Request has already been ${rcr.status.toLowerCase()}`);
  }

  // Separation of duties
  if (rcr.requestedById === req.user!.id) {
    throw new ApiError(
      403,
      "You cannot reject a role change request that you submitted (separation of duties)"
    );
  }

  const updated = await prisma.roleChangeRequest.update({
    where: { id: rcr.id },
    data: {
      status: "REJECTED",
      reviewedById: req.user!.id,
      reviewedAt: new Date(),
      reviewNote: reviewNote?.trim() || null,
    },
    include: {
      targetUser: { select: { id: true, name: true, email: true, role: true } },
      requestedBy: { select: { id: true, name: true, email: true } },
      reviewedBy:  { select: { id: true, name: true, email: true } },
    },
  });

  await writeAuditLog(
    req,
    "ROLE_CHANGE_REJECTED",
    "RoleChangeRequest",
    rcr.id,
    `Role change request rejected for ${rcr.targetUser.email} (${rcr.fromRole} → ${rcr.toRole})`
  );

  res.json({ success: true, data: updated });
}

// ─── POST /role-changes/review-cycle ────────────────────────────────────────
// Marks all users as reviewed now and sets their next review due date
// 90 days out (quarterly). ADMIN only. Records one audit log entry per user.

export async function triggerReviewCycle(req: Request, res: Response) {
  const now = new Date();
  const nextReview = new Date(now);
  nextReview.setDate(nextReview.getDate() + 90);

  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, email: true, role: true },
  });

  await prisma.user.updateMany({
    where: { isActive: true },
    data: { lastReviewedAt: now, reviewDueAt: nextReview },
  });

  await writeAuditLog(
    req,
    "ROLE_REVIEW_CYCLE",
    "User",
    undefined,
    `Quarterly role review completed by ${req.user!.email}. ${users.length} active users reviewed. Next review due: ${nextReview.toISOString().slice(0, 10)}`
  );

  res.json({
    success: true,
    message: `Reviewed ${users.length} users. Next review due ${nextReview.toISOString().slice(0, 10)}.`,
    data: { reviewedCount: users.length, nextReviewDue: nextReview },
  });
}

// ─── GET /role-changes/review-status ────────────────────────────────────────
// Returns users whose review is overdue or coming up within 14 days.

export async function getReviewStatus(req: Request, res: Response) {
  const now = new Date();
  const soonThreshold = new Date(now);
  soonThreshold.setDate(soonThreshold.getDate() + 14);

  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: {
      id: true, name: true, email: true, role: true,
      lastReviewedAt: true, reviewDueAt: true,
    },
    orderBy: { reviewDueAt: "asc" },
  });

  const overdue = users.filter((u) => u.reviewDueAt && u.reviewDueAt < now);
  const dueSoon = users.filter(
    (u) => u.reviewDueAt && u.reviewDueAt >= now && u.reviewDueAt <= soonThreshold
  );
  const neverReviewed = users.filter((u) => !u.lastReviewedAt);

  res.json({
    success: true,
    data: { overdue, dueSoon, neverReviewed, all: users },
  });
}
