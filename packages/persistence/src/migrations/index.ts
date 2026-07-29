import type { Migration } from "../migration-type";
import { migration001 } from "./001_initial_schema";

/**
 * The migration list, in version order.
 *
 * Append only. A released migration is never edited — a database that already
 * applied it would never see the change, so the two would diverge silently.
 */
export const MIGRATIONS: readonly Migration[] = [migration001];
