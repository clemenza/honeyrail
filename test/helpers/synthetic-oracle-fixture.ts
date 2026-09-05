import type { HistoricalPostgresStructuredOracle } from "../../server/postgres/historical-structured-oracle.js";

/**
 * Synthetic, domain-neutral structured oracle fixture shared between
 * historical-structured-oracle.test.ts and historical-postgres-003-task.test.ts.
 * Uses clearly placeholder tokens that bear no resemblance to any real
 * PostgreSQL transaction-isolation vocabulary (no "read committed",
 * "serializable", "repeatable read", "on", "off", etc.).
 */
export const SYNTHETIC_ORACLE: HistoricalPostgresStructuredOracle = {
  historical: { rows: [["alpha", "x", "y"]] },
  reference: { rows: [["beta", "m", "n"]] }
};
