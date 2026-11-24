import { Router } from "express";
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  addFollowUp,
} from "../controllers/customer.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { authenticate, authorize, requireApproved } from "../middleware/auth";

const router = Router();

router.use(authenticate, requireApproved);

// All roles can view customers
router.get("/", asyncHandler(listCustomers));
router.get("/:id", asyncHandler(getCustomer));

// Admin and Sales can create/edit customers and log follow-ups
router.post("/", authorize("ADMIN", "SALES"), asyncHandler(createCustomer));
router.put("/:id", authorize("ADMIN", "SALES"), asyncHandler(updateCustomer));
router.post("/:id/followups", authorize("ADMIN", "SALES"), asyncHandler(addFollowUp));

export default router;
