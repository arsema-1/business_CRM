// CLI: `npm run retention:sweep` — run the log retention sweep once from cron
// or a scheduled job, and exit non-zero if it could not complete. Useful when
// the API runs on an ephemeral host where an in-process daily timer may never
// fire often enough.
import "./env";
import { prisma } from "./config/db";
import { runRetentionSweep } from "./utils/retention";
import { flushLogShipment } from "./utils/logShipper";

async function main() {
  const result = await runRetentionSweep();

  console.log(
    `Retention sweep: ${result.appLogs.filesDeleted} app log file(s) removed ` +
      `(>${result.appLogs.policyDays} days, ${result.appLogs.bytesFreed} bytes); ` +
      `${result.audit.entriesBeyondRetention} audit entr(ies) past ` +
      `${result.audit.policyDays} days — ${result.audit.archiveDue ? "archival due" : "within policy"}.`
  );

  if (result.appLogs.errors > 0) {
    console.error(`${result.appLogs.errors} log file(s) could not be removed; see the log directory.`);
    process.exitCode = 1;
  }

  await flushLogShipment(2000);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Retention sweep failed:", err);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
});
