/**
 * Which module a file belongs to, and what is inside a module once it is opened.
 *
 * WHY THIS IS ITS OWN FILE, AND WHY IT IS NOT INLINE IN THE VIEW
 *
 * A module id and a file id are drawn from the same namespace. `moduleOf` maps a root file to
 * itself, so `package-lock.json` is simultaneously the id of a module and the id of the one file
 * inside it. Rendering both produced two SVG nodes carrying the same React key - the graph drew
 * one card on top of another and React warned about duplicate children.
 *
 * The rules that keep the two apart are pure functions of the file list, so they are tested
 * directly rather than through a browser. The view has no DOM-free seam otherwise.
 */

import { ALL_MODULES } from "./graph-url";

/** Top-level directory a file belongs to - the unit a module box represents. */
export function moduleOf(fileId: string): string {
  return fileId.split("/")[0] || "(root)";
}

/** A module as the scoping rules see it: an id, and how many files it holds. */
export interface ModuleSize {
  readonly id: string;
  readonly files: number;
}

/**
 * The modules the URL asks to open, reduced to the ones that can actually be opened.
 *
 * Three filters, each closing a different way of arriving at a broken picture:
 *
 * - An id that is not a module at all - a link followed after the repo was reindexed, or a
 *   hand-typed one - drops out instead of emptying the canvas.
 * - A module of one file has nothing to open into. The expand affordance is already hidden for
 *   it, but the URL could still name it, and opening it drew the module box AND its single file:
 *   the same id twice. The button's rule and this derivation now agree.
 * - The `all` sentinel expands to the openable set, never to the one-file modules, which stay on
 *   screen as closed cards rather than vanishing for lacking an inside.
 */
export function resolveOpenIds(open: string | null | undefined, modules: readonly ModuleSize[]): string[] {
  const openable = new Set(modules.filter((m) => m.files > 1).map((m) => m.id));
  if (open === ALL_MODULES) return modules.filter((m) => openable.has(m.id)).map((m) => m.id);
  return open && openable.has(open) ? [open] : [];
}

/**
 * The files drawn inside an opened module.
 *
 * A module is never its own child. The one-file case is already refused above, but a repository
 * holding BOTH a file `docs` and a directory `docs/` merges them into a single module with two
 * files - legitimately openable - whose members would otherwise include the file whose id equals
 * the module's. Same id, same key, one card hidden underneath another.
 */
export function moduleMembers<T extends { id: string }>(files: readonly T[], moduleId: string): T[] {
  return files.filter((f) => moduleOf(f.id) === moduleId && f.id !== moduleId);
}
