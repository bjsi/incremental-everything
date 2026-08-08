// RAW powerup-slot dump — evidence collector for RemNote support.
//
// WHY THIS EXISTS
// ---------------
// After RemNote's storage/sync overhaul, IncRems created before the change began
// reporting the wrong priority: the plugin shows 10 while the rem's own repetition
// history proves the last written value was something else (17 in the reported
// case), and the RemNote outliner renders the value under an *Unnamed* slot row.
//
// Every number the plugin displays for priority comes from
// getIncrementalRemFromRem, which reads the Priority slot and falls back to
// `let priority = 10` when the read comes back empty (lib/incremental_rem/index.ts).
// So a display of 10 is ambiguous on its own — it means either "10 is stored" or
// "nothing could be read". Same ambiguity the powerup READ-PATH diagnostic already
// documents for imported rems (see powerup_read_diagnostic.ts).
//
// The debug widget's "Priority" row shows that same post-fallback number, so it
// CANNOT settle the question either. This dump answers it, by ignoring
// getPowerupProperty entirely and reading the property rems directly:
//
//   * every child rem of the target that is a powerup property, with its text
//     verbatim — that text IS the stored value, fallbacks cannot reach it;
//   * which slot-definition rem each property is tagged with, by id AND name;
//   * whether that slot definition is the one getPowerupByCode() resolves to.
//
// A property holding "17" whose slot definition is unnamed and/or is not the
// registered Priority slot is exactly the "value is intact, the plugin can no
// longer reach it" case, stated in terms RemNote support can verify against their
// own storage.
//
// READ-ONLY. Every call is a getter; nothing here writes.

import { RNPlugin, PluginRem, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import {
  powerupCode,
  prioritySlotCode,
  nextRepDateSlotCode,
  repHistorySlotCode,
  originalIncrementalDateSlotCode,
  pdfStateSlotCode,
  dismissedPowerupCode,
  dismissedHistorySlotCode,
  dismissedDateSlotCode,
} from './consts';
import {
  CARD_PRIORITY_CODE,
  PRIORITY_SLOT,
  SOURCE_SLOT,
  LAST_UPDATED_SLOT,
} from './card_priority/types';
import { safeRemTextToString } from './pdfUtils';
import { getPowerupSlotByCodeSafe } from './powerup_slot_compat';
import { resolveRemTextToString } from './richTextRemRefs';

/** The powerups whose slots this dump covers, with the slot codes to probe. */
const SPECS = [
  {
    code: powerupCode,
    label: 'Incremental',
    slots: [
      prioritySlotCode,
      nextRepDateSlotCode,
      repHistorySlotCode,
      originalIncrementalDateSlotCode,
      pdfStateSlotCode,
    ],
  },
  {
    code: CARD_PRIORITY_CODE,
    label: 'CardPriority',
    slots: [PRIORITY_SLOT, SOURCE_SLOT, LAST_UPDATED_SLOT],
  },
  {
    code: dismissedPowerupCode,
    label: 'Dismissed',
    slots: [dismissedHistorySlotCode, dismissedDateSlotCode],
  },
] as const;

/** A slot definition rem belonging to a registered powerup. */
interface RegisteredSlot {
  slotCode: string;
  /** Resolved via getPowerupSlotByCodeSafe — what the plugin actually uses. */
  slotDefId: string | null;
  slotDefName: string;
  /** What the native (deprecated) getPowerupSlotByCode returned, for comparison. */
  nativeSlotDefId: string | null;
  nativeError: string | null;
}

interface RegisteredPowerup {
  label: string;
  code: string;
  powerupRemId: string | null;
  slots: RegisteredSlot[];
  /** Every slot child found on the powerup rem, whether or not we asked for it. */
  actualSlotChildren: Array<{ id: string; name: string }>;
}

/** One property rem hanging off the target — the raw stored value. */
export interface RawPropertyRow {
  /** Owning rem. */
  remId: string;
  remText: string;
  depth: number;
  /** The property rem itself. */
  propertyRemId: string;
  /** Its backText, verbatim — this is the stored value. */
  rawValue: string;
  rawValueLength: number;
  /** Raw element count of the backText, before any rendering. 0 = genuinely nothing stored. */
  rawElementCount: number;
  /**
   * Rem-reference ids inside the value. Date slots store a Daily Document
   * reference, so a non-empty list here with an empty `rawValue` means the
   * reference exists but its target could not be resolved — which is a very
   * different fault from the value having been lost.
   */
  rawValueRefIds: string[];
  /**
   * What each of those references actually points at. A date slot's value is a
   * Daily Document reference; if the target Rem no longer exists (or has lost its
   * text / its Date property) the value is unreachable even though the property
   * and its slot link are both healthy. That is a different fault from the
   * detached-slot one and needs reporting as such.
   */
  refTargets: Array<{
    id: string;
    exists: boolean;
    text: string | null;
    isDailyDoc: boolean;
    dailyDocDate: string | null;
  }>;
  /**
   * How the property's `text` renders — i.e. the slot reference. A healthy one
   * reads "[Priority]"; "[Untitled]" means the slot definition it points at has
   * lost its name, which is exactly the detached case.
   */
  slotReferenceLabel: string;
  isPowerupProperty: boolean;
  isProperty: boolean;
  /** Slot-definition rems this property is tagged with. */
  slotDefIds: string[];
  slotDefNames: string[];
  /** Which registered powerup+slot this property resolves to, if any. */
  matchedPowerup: string | null;
  matchedSlotCode: string | null;
  /** What getPowerupProperty returns for that slot — the plugin's actual read. */
  apiValue: string | null;
  /**
   * DETACHED   — a value is stored but its slot definition is not the registered
   *              one (or has no name), so the plugin cannot reach it.
   * API_BLIND  — the slot definition matches, the property holds a value, yet
   *              getPowerupProperty returns nothing. An SDK read bug.
   * OK         — stored value and API read agree.
   * EMPTY      — the property rem carries no value at all (zero elements).
   * UNRESOLVED_REF
   *            — the value IS present as a rem reference (e.g. a Daily Document
   *              for a date slot) but the target could not be resolved. Not the
   *              same as empty: something is stored, it just won't render.
   * UNKNOWN    — not attributable to any powerup this dump covers.
   */
  verdict: 'OK' | 'DETACHED' | 'API_BLIND' | 'EMPTY' | 'UNRESOLVED_REF' | 'UNKNOWN';
}

/** Per-rem summary of what the plugin reads vs. what is stored. */
export interface RawSlotRemRow {
  remId: string;
  remText: string;
  depth: number;
  powerups: string[];
  /** Total children walked. If slots read via the API but no property rem is
   *  listed for them, the value is not stored as a child rem at all. */
  childCount: number;
  /** Slot-by-slot: the API read next to the raw property value. */
  slots: Array<{
    powerup: string;
    slotCode: string;
    apiValue: string | null;
    rawValue: string | null;
    rawPropertyRemId: string | null;
    slotDefLinked: boolean | null;
    verdict: RawPropertyRow['verdict'];
  }>;
}

export interface RawSlotDumpReport {
  exportedAt: string;
  rootRemId: string;
  rootRemText: string;
  scannedRems: number;
  registered: RegisteredPowerup[];
  rems: RawSlotRemRow[];
  properties: RawPropertyRow[];
  /** Rems where a value is physically stored but the plugin reads nothing. */
  unreachable: RawPropertyRow[];
}

/** Rem-reference elements carried by a rich-text value, by id. */
export function refIdsIn(richText: unknown): string[] {
  if (!Array.isArray(richText)) return [];
  return (richText as any[])
    .filter((el) => el != null && typeof el === 'object' && el.i === 'q' && el._id)
    .map((el) => String(el._id));
}

/**
 * Plain text of a rich-text field, with EMPTY reported as empty.
 *
 * Two traps this avoids, both of which would make the dump lie about whether a
 * value is stored — the one question it exists to answer:
 *
 * 1. `safeRemTextToString` substitutes 'Untitled' for a null/empty field. Right
 *    for display, wrong here: it erases "nothing is stored".
 * 2. `plugin.richText.toString()` DROPS rem-reference elements (see
 *    lib/richTextRemRefs.ts). Date slots store a Daily Document *reference*, so
 *    a perfectly healthy `Next Rep Date` would come back as "" and be reported
 *    as EMPTY. References are resolved via `resolveRemTextToString` instead.
 */
export async function readRawText(plugin: RNPlugin, richText: unknown): Promise<string> {
  if (richText == null || !Array.isArray(richText) || richText.length === 0) return '';
  if (refIdsIn(richText).length > 0) {
    try {
      const resolved = await resolveRemTextToString(plugin, richText);
      // resolveRemTextToString returns 'Untitled' only when genuinely empty, but
      // it also returns it for a reference whose target has no text — so keep the
      // reference ids alongside (reported separately) rather than collapsing here.
      return resolved;
    } catch {
      /* fall through to the plain read */
    }
  }
  try {
    return (await plugin.richText.toString(richText as any)) ?? '';
  } catch {
    // Malformed rich text — report the shape rather than pretending it is empty.
    return `(unreadable rich text, ${richText.length} element(s))`;
  }
}

/** Resolve the registered powerup rems and their slot children, by id and name. */
async function readRegisteredPowerups(plugin: RNPlugin): Promise<RegisteredPowerup[]> {
  const out: RegisteredPowerup[] = [];

  for (const spec of SPECS) {
    const powerup = await plugin.powerup.getPowerupByCode(spec.code).catch(() => undefined);

    // Walk the powerup's slot children once and match by name — the same tolerant
    // matching getPowerupSlotByCodeSafe uses, since getPowerupSlotByCode itself is
    // deprecated at runtime on affected builds (see powerup_slot_compat.ts).
    const actualSlotChildren: Array<{ id: string; name: string }> = [];
    if (powerup) {
      const children = await powerup.getChildrenRem().catch(() => []);
      for (const child of children || []) {
        if (!(await child.isPowerupSlot().catch(() => false))) continue;
        actualSlotChildren.push({
          id: child._id,
          name: await safeRemTextToString(plugin, child.text),
        });
      }
    }

    const slots: RegisteredSlot[] = [];
    for (const slotCode of spec.slots) {
      // getPowerupSlotByCode resolves VISIBLE slots only; hidden ones throw
      // "only supports visible plugin powerup slots" (see powerup_slot_compat.ts).
      // So a null here is NOT evidence the slot is missing — getPowerupSlotByCodeSafe
      // is what the plugin actually uses, and its children-walk resolves hidden
      // slots fine. Record both, plus the error text, so the split is visible.
      let nativeSlotDefId: string | null = null;
      let nativeError: string | null = null;
      try {
        const slot = await plugin.powerup.getPowerupSlotByCode(spec.code, slotCode);
        nativeSlotDefId = slot?._id ?? null;
      } catch (e) {
        nativeError = String(e);
      }

      const resolved = await getPowerupSlotByCodeSafe(plugin, spec.code, slotCode);
      slots.push({
        slotCode,
        slotDefId: resolved?._id ?? null,
        slotDefName: resolved ? await safeRemTextToString(plugin, resolved.text) : '',
        nativeSlotDefId,
        nativeError,
      });
    }

    out.push({
      label: spec.label,
      code: spec.code,
      powerupRemId: powerup?._id ?? null,
      slots,
      actualSlotChildren,
    });
  }

  return out;
}

/**
 * Dumps the RAW stored value of every powerup property on `root` and its
 * descendants, alongside what the plugin's own read path returns for the same
 * slot. Read-only.
 *
 * @param maxRems Safety cap on how many rems are walked (large subtrees).
 */
export async function dumpRawPowerupSlots(
  plugin: RNPlugin,
  root: PluginRem,
  maxRems = 2000
): Promise<RawSlotDumpReport> {
  const registered = await readRegisteredPowerups(plugin);

  // slotDefId -> which powerup/slot it belongs to, for attributing a property rem.
  const slotDefIndex = new Map<string, { powerup: string; slotCode: string }>();
  for (const p of registered) {
    for (const s of p.slots) {
      if (s.slotDefId) slotDefIndex.set(s.slotDefId, { powerup: p.label, slotCode: s.slotCode });
    }
  }

  const rootText = await safeRemTextToString(plugin, root.text);
  const descendants = ((await root.getDescendants().catch(() => [])) || []) as PluginRem[];
  const targets = [root, ...descendants].slice(0, maxRems);

  // Depth relative to the root, so the dump reads like the outliner.
  const depthById = new Map<string, number>([[root._id, 0]]);

  const properties: RawPropertyRow[] = [];
  const rems: RawSlotRemRow[] = [];

  for (const node of targets) {
    // Only rems carrying one of the covered powerups are interesting.
    const carried: string[] = [];
    for (const spec of SPECS) {
      if (await node.hasPowerup(spec.code).catch(() => false)) carried.push(spec.label);
    }
    if (carried.length === 0) continue;

    if (!depthById.has(node._id)) {
      const parent = await node.getParentRem().catch(() => undefined);
      depthById.set(node._id, (parent && depthById.get(parent._id)) != null
        ? (depthById.get(parent!._id) as number) + 1
        : 1);
    }
    const depth = depthById.get(node._id) ?? 0;
    const remText = await safeRemTextToString(plugin, node.text);

    // ── The API read, per slot: what the plugin actually sees. ────────────────
    const apiByKey = new Map<string, string | null>();
    for (const spec of SPECS) {
      if (!carried.includes(spec.label)) continue;
      for (const slotCode of spec.slots) {
        let value: string | null = null;
        try {
          const raw = await node.getPowerupProperty(spec.code, slotCode);
          value = raw == null || raw === '' ? null : String(raw);
        } catch {
          value = null;
        }
        apiByKey.set(`${spec.label}:${slotCode}`, value);
      }
    }

    // ── The raw read: the property rems themselves. ───────────────────────────
    const children = ((await node.getChildrenRem().catch(() => [])) || []) as PluginRem[];
    const rawByKey = new Map<string, RawPropertyRow>();

    for (const child of children) {
      // isPowerupProperty is deprecated at runtime on affected builds (it throws;
      // see powerupSlotFilter.ts), so it must not be the gate — a property whose
      // flags don't answer would silently vanish from the dump, and "no property
      // rem found" is a conclusion we'd then draw from our own filter rather than
      // from the data. Every child is reported; the flags are just columns.
      const isPowerupProperty = await (child as any).isPowerupProperty?.().catch(() => false) ?? false;
      const isProperty = await (child as any).isProperty?.().catch(() => false) ?? false;

      // A powerup property rem's TEXT is a single reference to its slot
      // DEFINITION, and its BACKTEXT holds the value. (Same structure
      // powerupSlotFilter.ts relies on for slot detection.) So the reference id
      // in `text` is the link the plugin follows — when it points at a slot rem
      // that is not the registered definition, the value in `backText` becomes
      // unreachable while remaining perfectly intact on the Rem.
      const refIds = Array.isArray(child.text)
        ? (child.text as any[])
            .filter((el) => el != null && typeof el === 'object' && el.i === 'q' && el._id)
            .map((el) => String(el._id))
        : [];
      // Tags are a secondary link (CardPriority slot instances use them).
      const tags = ((await child.getTagRems().catch(() => [])) || []) as PluginRem[];
      const slotDefIds = Array.from(new Set([...refIds, ...tags.map((t) => t._id)]));

      const slotDefNames: string[] = [];
      for (const id of slotDefIds) {
        const defRem = await plugin.rem.findOne(id).catch(() => undefined);
        const name = defRem ? await safeRemTextToString(plugin, defRem.text) : '';
        slotDefNames.push(name === '' ? '(unnamed)' : name);
      }

      // THE VALUE. Not child.text — that resolves to the slot reference (which
      // is why an earlier revision of this dump reported "[Untitled]" and
      // "[Next Rep Date]" as though they were stored data).
      const rawValue = await readRawText(plugin, (child as any).backText);
      const match = slotDefIds.map((id) => slotDefIndex.get(id)).find((m) => !!m) || null;
      const apiValue = match ? apiByKey.get(`${match.powerup}:${match.slotCode}`) ?? null : null;

      // Follow each reference in the VALUE to its target. For a date slot this is
      // the Daily Document; a missing or textless target is why an otherwise
      // healthy property reads back as nothing.
      const valueRefIds = refIdsIn((child as any).backText);
      const refTargets: RawPropertyRow['refTargets'] = [];
      for (const id of valueRefIds) {
        const target = await plugin.rem.findOne(id).catch(() => undefined);
        if (!target) {
          refTargets.push({ id, exists: false, text: null, isDailyDoc: false, dailyDocDate: null });
          continue;
        }
        const text = await readRawText(plugin, target.text);
        let isDailyDoc = false;
        let dailyDocDate: string | null = null;
        try {
          isDailyDoc = await target.hasPowerup(BuiltInPowerupCodes.DailyDocument);
          if (isDailyDoc) {
            dailyDocDate =
              (await target.getPowerupProperty<BuiltInPowerupCodes.DailyDocument>(
                BuiltInPowerupCodes.DailyDocument,
                'Date'
              )) || null;
          }
        } catch {
          /* leave as not-a-daily-doc */
        }
        refTargets.push({ id, exists: true, text: text || null, isDailyDoc, dailyDocDate });
      }
      // A value made only of references that resolve to nothing usable.
      const allRefsDead =
        valueRefIds.length > 0 &&
        refTargets.every((t) => !t.exists || (!t.dailyDocDate && !t.text));

      // Is this child a powerup property at all? Either flag says so, and so does
      // a slot reference in its text — which is the one signal that survives the
      // deprecated flags. Ordinary content children are reported as UNKNOWN and
      // kept out of the unreachable list, so a note with back text is never
      // mistaken for a stranded slot value.
      const looksLikeProperty = isPowerupProperty || isProperty || refIds.length > 0;

      // "Rendered empty" and "nothing stored" are different. A date slot holds a
      // Daily Document reference; if that reference cannot be resolved the value
      // renders as "" while the elements are still there. Only zero elements is
      // genuinely empty.
      const backElements = Array.isArray((child as any).backText)
        ? (child as any).backText.length
        : 0;
      const renderedEmpty = rawValue.trim() === '';
      const genuinelyEmpty = backElements === 0;

      let verdict: RawPropertyRow['verdict'];
      if (!looksLikeProperty) {
        verdict = 'UNKNOWN';
      } else if (!match) {
        // Its slot reference points at a rem that is NOT one of the registered
        // slot definitions. If it still holds a value, that value is stranded.
        verdict = genuinelyEmpty ? 'EMPTY' : 'DETACHED';
      } else if (genuinelyEmpty) {
        verdict = 'EMPTY';
      } else if ((renderedEmpty || allRefsDead) && apiValue == null) {
        // The property and its slot link are both fine; the VALUE is a reference
        // whose target is gone or unusable.
        verdict = 'UNRESOLVED_REF';
      } else if (apiValue == null) {
        verdict = 'API_BLIND';
      } else {
        verdict = 'OK';
      }

      const row: RawPropertyRow = {
        remId: node._id,
        remText,
        depth,
        propertyRemId: child._id,
        rawValue,
        rawValueLength: rawValue.length,
        rawElementCount: Array.isArray((child as any).backText) ? (child as any).backText.length : 0,
        rawValueRefIds: valueRefIds,
        refTargets,
        slotReferenceLabel: await safeRemTextToString(plugin, child.text),
        isPowerupProperty,
        isProperty,
        slotDefIds,
        slotDefNames,
        matchedPowerup: match?.powerup ?? null,
        matchedSlotCode: match?.slotCode ?? null,
        apiValue,
        verdict,
      };
      properties.push(row);
      if (match) rawByKey.set(`${match.powerup}:${match.slotCode}`, row);
    }

    // ── Per-rem slot table: API value beside raw value. ───────────────────────
    const slots: RawSlotRemRow['slots'] = [];
    for (const spec of SPECS) {
      if (!carried.includes(spec.label)) continue;
      for (const slotCode of spec.slots) {
        const key = `${spec.label}:${slotCode}`;
        const apiValue = apiByKey.get(key) ?? null;
        const raw = rawByKey.get(key) ?? null;
        // No property rem carries this slot definition. If the API is also empty
        // the slot was simply never written; if the API has a value, the property
        // lives somewhere this walk didn't look.
        const verdict: RawPropertyRow['verdict'] = raw
          ? raw.verdict
          : apiValue == null
          ? 'EMPTY'
          : 'OK';
        slots.push({
          powerup: spec.label,
          slotCode,
          apiValue,
          rawValue: raw?.rawValue ?? null,
          rawPropertyRemId: raw?.propertyRemId ?? null,
          slotDefLinked: raw ? raw.matchedPowerup !== null : null,
          verdict,
        });
      }
    }

    rems.push({ remId: node._id, remText, depth, powerups: carried, childCount: children.length, slots });
  }

  // Values that are stored but the plugin cannot read — the whole point.
  const unreachable = properties.filter(
    (p) => p.verdict === 'DETACHED' || p.verdict === 'API_BLIND'
  );

  const report: RawSlotDumpReport = {
    exportedAt: new Date().toISOString(),
    rootRemId: root._id,
    rootRemText: rootText,
    scannedRems: rems.length,
    registered,
    rems,
    properties,
    unreachable,
  };

  logRawSlotDump(report);
  return report;
}

/** Console report, formatted for pasting into a support ticket. */
export function logRawSlotDump(report: RawSlotDumpReport): void {
  console.log('\n========== RAW POWERUP SLOT DUMP ==========');
  console.log(`Root: "${report.rootRemText}" [${report.rootRemId}]`);
  console.log(`Rems carrying a covered powerup: ${report.scannedRems}`);

  console.log('\n--- Registered powerups (what getPowerupByCode resolves to) ---');
  for (const p of report.registered) {
    console.log(`${p.label} (code: ${p.code}) -> powerup rem ${p.powerupRemId ?? '(none)'}`);
    console.table(p.slots.map((s) => ({
      slotCode: s.slotCode,
      slotDefId: s.slotDefId ?? '(unresolved)',
      slotDefName: s.slotDefName || '(unnamed)',
      nativeSlotDefId: s.nativeSlotDefId ?? '(none)',
      nativeError: s.nativeError ?? '',
    })));
    console.log('  slot children actually on the powerup rem:');
    console.table(p.actualSlotChildren.map((c) => ({ id: c.id, name: c.name || '(unnamed)' })));
  }

  console.log('\n--- Every stored property, raw ---');
  console.table(report.properties.map((p) => ({
    rem: p.remText.slice(0, 40),
    remId: p.remId,
    propertyRemId: p.propertyRemId,
    slotDefNames: p.slotDefNames.join(' | ') || '(untagged)',
    slotDefIds: p.slotDefIds.join(' | ') || '(none)',
    slotRef: p.slotReferenceLabel,
    matched: p.matchedPowerup ? `${p.matchedPowerup}:${p.matchedSlotCode}` : '(NO MATCH)',
    RAW: p.rawValue.slice(0, 60),
    API: p.apiValue === null ? '(empty)' : p.apiValue.slice(0, 60),
    verdict: p.verdict,
  })));

  if (report.unreachable.length === 0) {
    console.log('\nNo unreachable values: every stored property matched a registered slot');
    console.log('and read back through getPowerupProperty. Priorities the plugin shows');
    console.log('are the priorities that are stored.');
  } else {
    console.log(`\n*** ${report.unreachable.length} STORED VALUE(S) THE PLUGIN CANNOT READ ***`);
    console.table(report.unreachable.map((p) => ({
      rem: p.remText.slice(0, 40),
      remId: p.remId,
      propertyRemId: p.propertyRemId,
      slotDefNames: p.slotDefNames.join(' | ') || '(untagged)',
      slotRef: p.slotReferenceLabel,
      storedValue: p.rawValue.slice(0, 60),
      apiReturns: p.apiValue === null ? '(empty)' : p.apiValue,
      verdict: p.verdict,
    })));
    console.log('DETACHED  = the property is tagged with a slot rem that is NOT the');
    console.log('            registered slot definition. The value is intact in storage;');
    console.log('            getPowerupProperty walks the registered slot and finds');
    console.log('            nothing, so the plugin displays its read fallback instead.');
    console.log('API_BLIND = the slot definition IS the registered one and the property');
    console.log('            holds a value, yet getPowerupProperty returns nothing.');
  }
  console.log('===========================================\n');
}
