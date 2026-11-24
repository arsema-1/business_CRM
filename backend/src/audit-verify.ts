// CLI: `npm run audit:verify` — recompute the audit hash chain and fail the
// command if any entry was changed, removed or reordered. Intended for cron /
// CI, so a broken chain is noticed even when nobody opens the admin UI.
import "./env";
import { prisma } from "./config/db";
import { verifyAuditChain } from "./utils/auditChain";

async function main() {
  const result = await verifyAuditChain();

  if (result.valid) {
    console.log(
      `Audit chain OK — ${result.checked} entries verified, ` +
        `${result.legacyRows} pre-chain row(s) skipped, head ${result.head ?? "none"}`
    );
  } else {
    console.error(
      `Audit chain BROKEN at seq ${result.brokenAtSeq}: ${result.reason} ` +
        `(${result.checked} entries verified before the break)`
    );
    process.exitCode = 1;
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Audit verification failed:", err);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
});
