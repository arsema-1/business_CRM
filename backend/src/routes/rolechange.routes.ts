import { Router } from "express";
import {
  requestRoleChange,
  listRoleChanges,
  approveRoleChange,
  rejectRoleChange,
  triggerReviewCycle,
  getReviewStatus,
} from "../controllers/rolechange.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { authenticate, authorize, requireApproved } from "../middleware/auth";

const router = Router();

// All role-change routes require authentication + ADMIN role
router.use(authenticate, requireApproved, authorize("ADMIN"));

router.get("/", asyncHandler(listRoleChanges));
router.post("/", asyncHandler(requestRoleChange));
router.put("/:id/approve", asyncHandler(approveRoleChange));
router.put("/:id/reject", asyncHandler(rejectRoleChange));

// Review cycle (quarterly access review)
router.post("/review-cycle", asyncHandler(triggerReviewCycle));
router.get("/review-status", asyncHandler(getReviewStatus));

export default router;
