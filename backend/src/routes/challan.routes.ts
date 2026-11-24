import { Router } from "express";
import {
  listChallans,
  getChallan,
  createChallan,
  confirmChallan,
  cancelChallan,
} from "../controllers/challan.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { authenticate, authorize, requireApproved } from "../middleware/auth";

const router = Router();

router.use(authenticate, requireApproved);

// All roles can view challans
router.get("/", asyncHandler(listChallans));
router.get("/:id", asyncHandler(getChallan));

// Sales and Admin create + confirm + cancel challans
router.post("/", authorize("ADMIN", "SALES"), asyncHandler(createChallan));
router.put("/:id/confirm", authorize("ADMIN", "SALES"), asyncHandler(confirmChallan));
router.put("/:id/cancel", authorize("ADMIN", "SALES"), asyncHandler(cancelChallan));

export default router;
