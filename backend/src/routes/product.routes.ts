import { Router } from "express";
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  recordStockMovement,
  listStockMovements,
} from "../controllers/product.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { authenticate, authorize, requireApproved } from "../middleware/auth";

const router = Router();

router.use(authenticate, requireApproved);

// All roles can view products/stock
router.get("/", asyncHandler(listProducts));
router.get("/movements", asyncHandler(listStockMovements));
router.get("/:id", asyncHandler(getProduct));

// Admin and Warehouse manage the product catalog
router.post("/", authorize("ADMIN", "WAREHOUSE"), asyncHandler(createProduct));
router.put("/:id", authorize("ADMIN", "WAREHOUSE"), asyncHandler(updateProduct));

// Admin and Warehouse record stock movements (sales challan confirmation also triggers this internally)
router.post("/:id/stock", authorize("ADMIN", "WAREHOUSE"), asyncHandler(recordStockMovement));

export default router;
