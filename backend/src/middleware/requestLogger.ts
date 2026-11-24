import { Request, Response, NextFunction } from "express";
import { logger, safeUrl } from "../utils/logger";

// One structured line per request: who called what, from where, with what
// outcome and how long it took. Health checks are skipped so uptime probes do
// not drown the log; every other endpoint (including 401/403s) is recorded, so
// refusals are visible even when a business controller never runs.
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const path = safeUrl(req.originalUrl);
    if (path.startsWith("/health")) return;

    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;
    const meta = {
      method: req.method,
      path,
      status: res.statusCode,
      durationMs,
      ip: req.ip,
      userEmail: req.user?.email,
      userRole: req.user?.role,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    };

    if (res.statusCode >= 500) logger.error("HTTP_REQUEST", "Request failed", undefined, meta);
    else if (res.statusCode >= 400) logger.warn("HTTP_REQUEST", "Request rejected", meta);
    else logger.info("HTTP_REQUEST", "Request handled", meta);
  });

  next();
}
