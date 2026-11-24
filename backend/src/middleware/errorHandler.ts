import { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/ApiError";
import { writeSystemEvent } from "../utils/audit";
import { logger } from "../utils/logger";

// Server-side failures get an operational log line and a system event in the
// audit trail (task 2.2); client errors are already visible in the access log.
function reportServerError(req: Request, status: number, err: unknown) {
  if (status < 500) return;
  const message = err instanceof Error ? err.message : "unknown error";
  logger.error("REQUEST_FAILED", `${req.method} ${req.originalUrl} returned ${status}`, err, {
    userEmail: req.user?.email,
    ip: req.ip,
  });
  void writeSystemEvent(
    "SERVICE_FAILURE",
    `${req.method} ${req.originalUrl} returned ${status}: ${message}`.slice(0, 500),
    "WARN"
  );
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
}

// Express recognizes this as an error handler because it has 4 args
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    reportServerError(req, err.statusCode, err);
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      details: err.details,
    });
  }

  // Prisma unique constraint violation
  if (typeof err === "object" && err !== null && "code" in err && (err as any).code === "P2002") {
    return res.status(409).json({
      success: false,
      message: `Duplicate value for field(s): ${(err as any).meta?.target?.join(", ") ?? "unknown"}`,
    });
  }

  reportServerError(req, 500, err);
  console.error(err);
  return res.status(500).json({ success: false, message: "Internal server error" });
}
