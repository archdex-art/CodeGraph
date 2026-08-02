import type { SqliteDatabase } from "./sqlite";

/**
 * A single schema or data migration (LLD §8.2).
 *
 * In its own module, not in `migrate.ts`, to break an import cycle: each
 * migration needs this type, `migrations/index.ts` collects the migrations, and
 * `migrate.ts` consumes that list. Declaring the type in `migrate.ts` made
 * migration → migrate → index → migration, which the layering gate rejects
 * (HLD §6.1) and which is a genuine ordering hazard, not just a lint complaint.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  /**
   * Runs inside a transaction opened by the runner. Throwing rolls the whole
   * version back, so a migration must never open its own transaction.
   */
  up(db: SqliteDatabase): void;
}
