import { Router } from "express";
import { getDashboard, getAccountsDashboard } from "../controllers/dashboard.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { authenticate, authorize, requireApproved } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, requireApproved, asyncHandler(getDashboard));
router.get("/accounts", authenticate, requireApproved, authorize("ADMIN", "ACCOUNTS"), asyncHandler(getAccountsDashboard));

export default router;
