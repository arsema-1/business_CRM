import { Router } from "express";
import {
  listUsers,
  createUser,
  updateUser,
  resetPassword,
  resetMfa,
  approveUser,
} from "../controllers/user.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { authenticate, authorize, requireApproved } from "../middleware/auth";

const router = Router();

router.use(authenticate, requireApproved, authorize("ADMIN"));

router.get("/", asyncHandler(listUsers));
router.post("/", asyncHandler(createUser));
router.put("/:id", asyncHandler(updateUser));
router.put("/:id/approve", asyncHandler(approveUser));
router.put("/:id/reset-password", asyncHandler(resetPassword));
router.post("/:id/mfa/reset", asyncHandler(resetMfa));

export default router;
