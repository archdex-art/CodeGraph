import { db } from "./db";

/**
 * Per-account key/value settings.
 *
 * `user_id = 0` is the "no account" bucket — self-hosted with no GitHub sign-in,
 * or an anonymous visitor on a deployment that has it — mirroring the
 * `owner_id IS NULL` public-bucket convention used for repos. Isolation here is
 * by the composite primary key `(key, user_id)`, so one account's saved API key
 * can never be read or overwritten by another.
 */

export function readSetting(key: string, userId: number): string | null {
  const row = db()
    .prepare("SELECT value FROM settings WHERE key = ? AND user_id = ?")
    .get(key, userId) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Writing an empty value deletes the row, so "unset" has one representation. */
export function writeSetting(key: string, userId: number, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    db().prepare("DELETE FROM settings WHERE key = ? AND user_id = ?").run(key, userId);
    return;
  }
  db()
    .prepare(
      `INSERT INTO settings (key, user_id, value) VALUES (?, ?, ?)
       ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value`,
    )
    .run(key, userId, trimmed);
}
