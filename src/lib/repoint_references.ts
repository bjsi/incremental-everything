import type { PluginRem, RichTextInterface, RNPlugin } from '@remnote/plugin-sdk';
import { SuppressionLease } from './operation_suppression';

/**
 * Repointing references whose target was never created.
 *
 * RemNote's copy/import pipeline (the `srcRemC: "a/fakeImportArticle…"` marker)
 * can rewrite a reference to a fresh id while the target itself is copied under
 * another one. The reference then points at an id no Rem carries: RemNote lists
 * it in `missing_ids_quanta` and renders it as "Loading" forever. Once the real
 * target is found (through `srcRemId` and an older snapshot), the fix is to swap
 * the id and nothing else, so pin, content, showFullName, aliasId and cId stay.
 */

/** Old target id → new target id. */
export type RefIdMap = Record<string, string>;

/**
 * Rich text with every reference (`{i:'q', _id}`) and inline link (`qId`) whose
 * target is in `map` repointed. Elements are cloned, never mutated.
 */
export function repointRichText(
  text: RichTextInterface,
  map: RefIdMap
): { text: RichTextInterface; changed: number } {
  let changed = 0;
  const out = text.map((el) => {
    if (typeof el !== 'object' || el === null) return el;
    const anyEl = el as any;
    if (anyEl.i === 'q' && map[anyEl._id]) {
      changed++;
      return { ...anyEl, _id: map[anyEl._id] };
    }
    if (typeof anyEl.qId === 'string' && map[anyEl.qId]) {
      changed++;
      return { ...anyEl, qId: map[anyEl.qId] };
    }
    return el;
  }) as RichTextInterface;
  return { text: out, changed };
}

/** Parse a pasted `{ "oldId": "newId" }` map. Throws with a readable message. */
export function parseRefIdMap(raw: string): RefIdMap {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object: { "oldId": "newId" }');
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string' || !v || !k) throw new Error(`Bad entry: ${k} → ${String(v)}`);
  }
  return parsed as RefIdMap;
}

/** Rem id → the repointing for that Rem, as the snapshot analysis produces it. */
export type RefIdPlan = Record<string, RefIdMap>;

/** Parse a pasted `{ "remId": { "oldId": "newId" } }` plan. */
export function parseRefIdPlan(raw: string): RefIdPlan {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object: { "remId": { "oldId": "newId" } }');
  }
  for (const [remId, map] of Object.entries(parsed)) {
    if (typeof map !== 'object' || map === null) {
      throw new Error(`${remId}: expected { "oldId": "newId" } — is this the single-Rem map?`);
    }
    parseRefIdMap(JSON.stringify(map));
  }
  return parsed as RefIdPlan;
}

type FindRem = (id: string) => Promise<PluginRem | undefined>;

/** The new targets in `maps` that no Rem carries. */
async function unresolvedTargets(maps: RefIdMap[], findRem: FindRem): Promise<string[]> {
  const unresolved: string[] = [];
  for (const id of new Set(maps.flatMap((m) => Object.values(m)))) {
    if (!(await findRem(id))) unresolved.push(id);
  }
  return unresolved;
}

/** Repoint a Rem's front and back; writes only the sides that change. */
async function repointRem(rem: PluginRem, map: RefIdMap): Promise<{ front: number; back: number }> {
  const front = repointRichText((rem.text ?? []) as RichTextInterface, map);
  const back = repointRichText((rem.backText ?? []) as RichTextInterface, map);
  if (front.changed) await rem.setText(front.text);
  if (back.changed) await rem.setBackText(back.text);
  return { front: front.changed, back: back.changed };
}

export interface RepointReport {
  front: number;
  back: number;
  /** Map entries whose new target does not resolve; nothing is written when non-empty. */
  unresolved: string[];
}

/**
 * Repoint the references in a Rem's front and back. Every new target must
 * resolve first, so a typo cannot swap one broken reference for another.
 */
export async function repointRemReferences(
  rem: PluginRem,
  map: RefIdMap,
  findRem: FindRem
): Promise<RepointReport> {
  const unresolved = await unresolvedTargets([map], findRem);
  if (unresolved.length) return { front: 0, back: 0, unresolved };
  return { ...(await repointRem(rem, map)), unresolved };
}

export interface RepointBatchReport {
  /** Rems with at least one reference repointed. */
  rems: number;
  references: number;
  /** Rems that exist but no longer hold any of their old ids (already fixed, or edited since). */
  unchanged: string[];
  /** Rem ids in the plan that no longer exist. */
  missingRems: string[];
  failed: { remId: string; error: string }[];
  /** New targets that do not exist; nothing is written when non-empty. */
  unresolved: string[];
}

/**
 * Apply a whole plan. All new targets are checked before the first write; the
 * GlobalRemChanged listener stands down for the run (a swapped reference id is
 * nothing it needs to react to), under a lease so a closed popup cannot leave
 * it suppressed.
 */
export async function repointPlan(
  plugin: RNPlugin,
  plan: RefIdPlan,
  onProgress?: (done: number, total: number) => void
): Promise<RepointBatchReport> {
  const findRem: FindRem = (id) => plugin.rem.findOne(id);
  const report: RepointBatchReport = { rems: 0, references: 0, unchanged: [], missingRems: [], failed: [], unresolved: [] };
  report.unresolved = await unresolvedTargets(Object.values(plan), findRem);
  if (report.unresolved.length) return report;

  const entries = Object.entries(plan);
  const lease = new SuppressionLease(plugin);
  await lease.start();
  try {
    for (const [i, [remId, map]] of entries.entries()) {
      await lease.renew();
      try {
        const rem = await findRem(remId);
        if (!rem) {
          report.missingRems.push(remId);
        } else {
          const { front, back } = await repointRem(rem, map);
          if (front + back) {
            report.rems++;
            report.references += front + back;
          } else {
            report.unchanged.push(remId);
          }
        }
      } catch (e) {
        report.failed.push({ remId, error: e instanceof Error ? e.message : String(e) });
      }
      onProgress?.(i + 1, entries.length);
    }
  } finally {
    await lease.release();
  }
  return report;
}
