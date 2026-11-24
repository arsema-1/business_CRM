import { Router } from "express";
import {
  acknowledgeAlert,
  getSecurityTrends,
  listAlerts,
} from "../controllers/monitoring.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { authenticate, authorize, requireApproved } from "../middleware/auth";

const router = Router();

// Security monitoring is an administrator function: it exposes failed-actor
// history and the health of the logging pipeline. Read-only.
router.get(
  "/security-trends",
  authenticate,
  requireApproved,
  authorize("ADMIN"),
  asyncHandler(getSecurityTrends)
);

// Routed alerts: list (open by default) and acknowledge. Acknowledgement is
// what stops the escalation sweep re-notifying the team.
router.get("/alerts", authenticate, requireApproved, authorize("ADMIN"), asyncHandler(listAlerts));
router.post(
  "/alerts/:id/acknowledge",
  authenticate,
  requireApproved,
  authorize("ADMIN"),
  asyncHandler(acknowledgeAlert)
);

export default router;
