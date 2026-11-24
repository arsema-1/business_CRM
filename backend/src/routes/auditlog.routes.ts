import { Router } from "express";
import { listAuditLogs, verifyAuditLogs } from "../controllers/auditlog.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { authenticate, authorize, requireApproved } from "../middleware/auth";

const router = Router();

// The trail is readable only by an approved administrator. There is no write,
// update or delete endpoint anywhere: records are appended by the application
// itself and protected by a database-level append-only trigger.
router.get("/", authenticate, requireApproved, authorize("ADMIN"), asyncHandler(listAuditLogs));
router.get("/verify", authenticate, requireApproved, authorize("ADMIN"), asyncHandler(verifyAuditLogs));

export default router;
