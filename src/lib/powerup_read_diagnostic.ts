// Powerup READ-PATH diagnostic.
//
// WHY THIS EXISTS
// ---------------
// Rems imported from another knowledge base showed the wrong priorities: cards at
// the default, IncRems at 10. Three rounds of investigation blamed three different
// write paths. All three were wrong. Exporting the document from BOTH knowledge
// bases and diffing the raw files settled it (see scripts/analyze_rem_export.js):
//
//   source KB export:  cardPriority_priority = "30", lastUpdated = 1785414094101
//   target KB export:  cardPriority_priority = "30", lastUpdated = 1785414094101
//
// Identical, lastUpdated included. So the import preserved the data perfectly and
// nothing rewrote it — the values are sitting in the target KB right now, correct.
//
// Which means nothing was ever LOST. The plugin simply cannot READ them, and every
// wrong number we chased was a read fallback being displayed:
//
//   cards at 50  — getCardPriority finds no value and returns the default without
//                  writing (lib/card_priority/index.ts, the `else` branch).
//   IncRems at 10 — getIncrementalRemFromRem's `let priority = 10` fallback
//                  (lib/incremental_rem/index.ts).
//
// Neither writes, which is exactly why lastUpdated never moved.
//
// So the open question is narrow: why does getPowerupProperty(code, slot) return
// nothing for a rem whose stored data plainly contains cardPriority_priority?
// The leading candidate is powerup IDENTITY — `rem.getTagRems()` returning a
// powerup rem that is not the one `getPowerupByCode(code)` resolves to, so the
// slot lookup walks the wrong definition. This probe answers that directly instead
// of inferring it.
//
// READ-ONLY. Every call here is a getter; nothing is written.

import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import {
  powerupCode,
  prioritySlotCode,
  nextRepDateSlotCode,
  repHistorySlotCode,
  originalIncrementalDateSlotCode,
} from './consts';
import {
  CARD_PRIORITY_CODE,
  PRIORITY_SLOT,
  SOURCE_SLOT,
  LAST_UPDATED_SLOT,
} from './card_priority/types';
import { safeRemTextToString } from './pdfUtils';

const SPECS = [
  { code: CARD_PRIORITY_CODE, label: 'CardPriority', slots: [PRIORITY_SLOT, SOURCE_SLOT, LAST_UPDATED_SLOT] },
  {
    code: powerupCode,
    label: 'Incremental',
    slots: [prioritySlotCode, nextRepDateSlotCode, repHistorySlotCode, originalIncrementalDateSlotCode],
  },
];

export interface PowerupReadReport {
  remId: string;
  remText: string;
  /** Per powerup: what the code resolves to vs. what the rem is actually tagged with. */
  powerups: Array<{
    label: string;
    code: string;
    registeredId: string | null;
    registeredSlots: string;
    hasPowerup: boolean;
    /** Tag rems on this rem whose name matches this powerup. */
    matchingTags: Array<{ id: string; name: string; isRegistered: boolean; slots: string }>;
    /** getPowerupProperty per slot — the call the plugin actually relies on. */
    slotReads: Array<{ slot: string; value: string; richTextLen: number | null }>;
    verdict: string;
  }>;
  allTags: Array<{ id: string; name: string }>;
}

/**
 * Probes how the plugin's read path behaves on one rem, for BOTH powerups.
 * Logs a report and returns it structured for the debug widget.
 */
export async function diagnosePowerupReadPath(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<PowerupReadReport> {
  const remText = await safeRemTextToString(plugin, rem.text);

  // Every tag on the rem, resolved to a name, so identity mismatches are visible.
  const tagRems = ((await rem.getTagRems().catch(() => [])) || []) as PluginRem[];
  const allTags: Array<{ id: string; name: string }> = [];
  for (const t of tagRems) {
    allTags.push({ id: t._id, name: await safeRemTextToString(plugin, t.text) });
  }

  const slotNamesOf = async (p: PluginRem | undefined | null): Promise<string> => {
    if (!p) return '(n/a)';
    try {
      const kids = (await p.getChildrenRem()) || [];
      const names: string[] = [];
      for (const k of kids) {
        if (await k.isSlot().catch(() => false)) {
          names.push(await safeRemTextToString(plugin, k.text));
        }
      }
      return names.length ? names.join(' | ') : '(no slot children)';
    } catch {
      return '(unreadable)';
    }
  };

  const powerups: PowerupReadReport['powerups'] = [];

  for (const spec of SPECS) {
    const registered = await plugin.powerup.getPowerupByCode(spec.code).catch(() => undefined);
    const registeredId = registered?._id ?? null;
    const registeredSlots = await slotNamesOf(registered as any);
    const hasPowerup = await rem.hasPowerup(spec.code).catch(() => false);

    // Tags whose NAME matches this powerup — the population in which an imported
    // duplicate would hide. Compared by id against the registered one.
    const matchingTags: PowerupReadReport['powerups'][number]['matchingTags'] = [];
    for (const t of tagRems) {
      const name = await safeRemTextToString(plugin, t.text);
      if (name.trim().toLowerCase() !== spec.label.toLowerCase()) continue;
      matchingTags.push({
        id: t._id,
        name,
        isRegistered: t._id === registeredId,
        slots: await slotNamesOf(t),
      });
    }

    // The reads the plugin actually depends on.
    const slotReads: PowerupReadReport['powerups'][number]['slotReads'] = [];
    for (const slot of spec.slots) {
      let value = '(threw)';
      try {
        const raw = await rem.getPowerupProperty(spec.code, slot);
        value = raw == null || raw === '' ? '(empty)' : String(raw).slice(0, 120);
      } catch (e: any) {
        value = `(threw: ${e?.message ?? e})`;
      }
      // getIncrementalRemFromRem reads priority as rich text, so probe that too —
      // the two accessors can disagree.
      let richTextLen: number | null = null;
      try {
        const rt = await (rem as any).getPowerupPropertyAsRichText?.(spec.code, slot);
        richTextLen = Array.isArray(rt) ? rt.length : null;
      } catch {
        richTextLen = null;
      }
      slotReads.push({ slot, value, richTextLen });
    }

    const anyValue = slotReads.some((s) => s.value !== '(empty)' && !s.value.startsWith('(threw'));
    const taggedButForeign = matchingTags.length > 0 && matchingTags.every((t) => !t.isRegistered);

    let verdict: string;
    if (anyValue) {
      verdict = 'READS OK — the plugin can see this powerup\'s values.';
    } else if (taggedButForeign) {
      verdict =
        'BROKEN + IDENTITY MISMATCH: the rem is tagged with a "' + spec.label +
        '" rem that is NOT the one getPowerupByCode() returns. The slot lookup is ' +
        'walking the wrong definition. Fix = re-point the tag (migration), not a write path.';
    } else if (matchingTags.length > 0) {
      verdict =
        'BROKEN despite the tag being the registered powerup. Identity is fine, so ' +
        'the failure is inside getPowerupProperty / slot resolution itself. Compare ' +
        'the registered slot children below against the stored `<code>_<slot>` keys.';
    } else if (hasPowerup) {
      verdict =
        'hasPowerup() is true but no matching tag was found via getTagRems(), and no ' +
        'value reads. The two APIs disagree — report this.';
    } else {
      verdict = 'This rem does not carry this powerup at all.';
    }

    powerups.push({
      label: spec.label,
      code: spec.code,
      registeredId,
      registeredSlots,
      hasPowerup,
      matchingTags,
      slotReads,
      verdict,
    });
  }

  // ── Console report ────────────────────────────────────────────────────────
  console.log('\n========== POWERUP READ-PATH DIAGNOSTIC ==========');
  console.log(`Rem: "${remText}"  [${rem._id}]`);
  console.log(`All tags on this rem: ${allTags.map((t) => `${t.name}#${t.id}`).join(', ') || '(none)'}`);

  for (const p of powerups) {
    console.log(`\n--- ${p.label} (code: ${p.code}) ---`);
    console.log(`  getPowerupByCode() -> ${p.registeredId ?? '(none)'}`);
    console.log(`  its slot children  : ${p.registeredSlots}`);
    console.log(`  rem.hasPowerup()   : ${p.hasPowerup}`);
    if (p.matchingTags.length === 0) {
      console.log('  matching tags      : (none)');
    } else {
      for (const t of p.matchingTags) {
        console.log(
          `  matching tag       : ${t.id} ${t.isRegistered ? '== REGISTERED' : '!= REGISTERED  <-- mismatch'}`
        );
        console.log(`      its slots      : ${t.slots}`);
      }
    }
    console.table(p.slotReads);
    console.log(`  VERDICT: ${p.verdict}`);
  }
  console.log('\nNEXT STEP — this probe CANNOT tell you whether the data exists.');
  console.log('"(empty)" has two possible meanings and they need different fixes:');
  console.log('  a) the value is stored but unreadable  -> a plugin/SDK read bug');
  console.log('  b) the value is not in this KB at all  -> the import dropped it');
  console.log('Only the raw storage can distinguish them. Export THIS document from THIS');
  console.log('knowledge base and read the file:');
  console.log('  node scripts/analyze_rem_export.js <export.rem>');
  console.log('If it shows cardPriority_priority, the read is broken (a). If it shows');
  console.log('nothing, the value never arrived here (b) and no read fix would help.');
  console.log('Do NOT carry a result over from another KB — the import behaved');
  console.log('differently in different KBs, which is the whole puzzle.');
  console.log('==================================================\n');

  return { remId: rem._id, remText, powerups, allTags };
}
