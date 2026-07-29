import type { Migration } from "../migration-type";
import { migration001 } from "./001_initial_schema";
import { migration002 } from "./002_findings_rows";
import { migration003 } from "./003_backfill_findings";

/**
 * The migration list, in version order.
 *
 * Append only. A released migration is never edited — a database that already
 * applied it would never see the change, so the two would diverge silently
 * (LLD §8.2).
 */
export const MIGRATIONS: readonly Migration[] = [migration001, migration002, migration003];
