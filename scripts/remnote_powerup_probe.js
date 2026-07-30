/*
 * remnote_powerup_probe.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GROUND-TRUTH PROBE for the Incremental / CardPriority powerups.
 *
 * Answers, without the plugin's help: does an imported document actually carry
 * its Incremental and CardPriority data, and is that data attached to the
 * powerup this KB registered or to an imported duplicate?
 *
 * Uses no plugin API — it reads RemNote's own IndexedDB. Run it with the plugin
 * DISABLED and nothing can have touched the data before you look.
 *
 * STRICTLY READ-ONLY. Every transaction is opened 'readonly'; there is no
 * put/add/delete against any store anywhere in this file.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────
 *  1. Disable the Incremental Everything plugin.
 *  2. Import (or open) the document to inspect.
 *  3. RemNote → View → Toggle Developer Tools → Console.
 *  4. Paste this whole file, press Enter, and WAIT for it to finish.
 *  5. The report is copied to your clipboard automatically. Paste it anywhere.
 *
 * It does NOT print to the console, deliberately: RemNote patches `console`, so
 * console.log output can vanish (that is why the first version of this script
 * appeared to do nothing). Instead the report is:
 *   - copied to the clipboard via DevTools' copy(),
 *   - stored in  window.__probeReport,
 *   - returned as the value of the expression.
 * If the clipboard copy fails, run this afterwards to see it:
 *     window.__probeReport
 *
 * ── IF IT REPORTS NO DATABASES ──────────────────────────────────────────────
 * RemNote's desktop storage changed with the sync overhaul and may no longer use
 * IndexedDB at all. In that case this probe cannot see anything, and the reliable
 * tool is scripts/analyze_rem_export.js, which reads an exported .rem file
 * directly and needs neither RemNote nor the plugin.
 */

(async () => {
  'use strict';

  // ── CONFIG ────────────────────────────────────────────────────────────────
  /** A distinctive word from the document to inspect. null = discovery only. */
  const MATCH = 'Other test document across KB';
  /** Cap on records read per store, so a large KB doesn't hang the console. */
  const SCAN_LIMIT = 300000;
  // ──────────────────────────────────────────────────────────────────────────

  const out = [];
  const say = (...a) =>
    out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const hr = (t) => { say(''); say('='.repeat(78)); say(t); say('='.repeat(78)); };

  const finish = () => {
    const report = out.join('\n');
    try { window.__probeReport = report; } catch { /* ignore */ }
    try { copy(report); report_copied = true; } catch { /* copy() is DevTools-only */ }
    return report;
  };
  let report_copied = false;

  try {
    // Names we care about — BOTH powerups and all their slots.
    const POWERUPS = ['cardpriority', 'incremental'];
    const SLOTS = [
      'priority', 'priority source', 'last updated',   // CardPriority
      'next rep date', 'history', 'created',           // Incremental
    ];

    hr('1. DATABASES');
    let dbList = [];
    try {
      dbList = (await indexedDB.databases()) || [];
    } catch (e) {
      say('indexedDB.databases() failed:', e.message);
    }
    if (dbList.length === 0) {
      say('No IndexedDB databases visible from this context.');
      say('');
      say('This most likely means RemNote no longer stores rems in IndexedDB');
      say('(the storage/sync overhaul). This probe cannot help; use');
      say('scripts/analyze_rem_export.js on an exported .rem file instead.');
      return finish();
    }
    for (const d of dbList) say(`  ${d.name} (v${d.version})`);

    const openDb = (name) =>
      new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error || new Error('open error'));
        r.onblocked = () => rej(new Error('blocked'));
      });

    const readAll = (db, store, limit) =>
      new Promise((res) => {
        try {
          const req = db.transaction(store, 'readonly').objectStore(store).getAll(undefined, limit);
          req.onsuccess = () => res(req.result || []);
          req.onerror = () => res([]);
        } catch { res([]); }
      });

    hr('2. OBJECT STORES');
    const candidates = [];
    for (const meta of dbList) {
      let db;
      try { db = await openDb(meta.name); }
      catch (e) { say(`  ${meta.name}: cannot open (${e.message})`); continue; }
      for (const store of Array.from(db.objectStoreNames)) {
        const sample = await readAll(db, store, 3);
        if (!sample.length) { say(`  ${meta.name}/${store}: empty`); continue; }
        const keys = Object.keys(sample[0] || {});
        say(`  ${meta.name}/${store}: fields = ${keys.join(', ')}`);
        const hasId = keys.some((k) => /^_?id$/i.test(k));
        const remmy = keys.some((k) => /^(key|text|children|parent|tags?|powerup)/i.test(k));
        if (hasId && remmy) candidates.push({ dbName: meta.name, db, store });
      }
    }

    if (!candidates.length) {
      hr('RESULT — no rem-like store found');
      say('Send me the store/field listing above and I will retarget the probe.');
      return finish();
    }

    hr('3. LOADING REMS');
    let rems = [], picked = null;
    for (const c of candidates) {
      const all = await readAll(c.db, c.store, SCAN_LIMIT);
      say(`  ${c.dbName}/${c.store}: ${all.length} records`);
      if (all.length > rems.length) { rems = all; picked = c; }
    }
    if (!rems.length) { say('No records loaded.'); return finish(); }
    say(`Using ${picked.dbName}/${picked.store} (${rems.length} records).`);
    say('');
    say('Sample record (so the field inference can be checked):');
    say(JSON.stringify(rems[0]).slice(0, 900));

    const idOf = (r) => r._id ?? r.id;
    const pick = (names) => names.find((n) => rems.some((r) => r && r[n] !== undefined)) || null;
    const F = {
      text: pick(['key', 'text', 'name', 'k']),
      children: pick(['children', 'c', 'childrenIds']),
      parent: pick(['parent', 'p', 'parentId']),
      tags: pick(['tags', 'tagIds', 't', 'powerups']),
    };
    say('');
    say('Inferred fields: ' + JSON.stringify(F));
    if (!F.text) { say('Could not infer the text field — send the sample above.'); return finish(); }

    const byId = new Map();
    for (const r of rems) { const i = idOf(r); if (i) byId.set(i, r); }

    const textOf = (r) => {
      if (!r) return '';
      const v = r[F.text];
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (!Array.isArray(v)) return String(v);
      return v.map((el) =>
        typeof el === 'string' ? el
          : el && typeof el === 'object'
            ? (typeof el.text === 'string' ? el.text : `[ref:${el._id ?? '?'}]`)
            : ''
      ).join('');
    };
    const ids = (r, f) => {
      const v = f && r ? r[f] : null;
      if (!v) return [];
      return (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'string' ? x : x?._id)).filter(Boolean);
    };

    // ── 4. How many powerup rems of each name actually exist ────────────────
    //
    // Counting RECORDS in storage, not indicators in the editor. A recent RemNote
    // change renders a powerup with both a tag indicator and a powerup indicator,
    // so a rem can show "CardPriority" twice in the tag bar while carrying a
    // single powerup. That display tells us nothing; distinct _id values here do.
    hr('4. POWERUP RECORDS PER NAME (distinct ids, not editor indicators)');
    const puByName = new Map();
    for (const r of rems) {
      const t = textOf(r).trim().toLowerCase();
      if (POWERUPS.includes(t)) {
        if (!puByName.has(t)) puByName.set(t, []);
        puByName.get(t).push(r);
      }
    }
    for (const name of POWERUPS) {
      const list = puByName.get(name) || [];
      say(`"${name}": ${list.length} rem(s) with this name`);
      for (const p of list) {
        const kids = ids(p, F.children).map((i) => textOf(byId.get(i))).filter(Boolean);
        // Any field that marks this rem as a real powerup rather than a plain copy.
        const flags = Object.entries(p)
          .filter(([k, v]) => /powerup|isPowerup|enum|slot/i.test(k) && v)
          .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`);
        say(`   id=${idOf(p)}  slots: ${kids.join(' | ') || '(none)'}`);
        say(`        powerup-ish fields: ${flags.join(', ') || '(none)'}`);
      }
      if (list.length === 1) {
        say('   -> single record: powerup identity is NOT the problem. Whatever went');
        say('      wrong is either the values never arriving, or something writing over');
        say('      them afterwards.');
      } else if (list.length > 1) {
        say(`   -> ${list.length} distinct records share this name. Worth investigating,`);
        say('      but not conclusive on its own: check in section 6 whether the values');
        say('      actually sit on a different id from the one the plugin writes to.');
      }
    }

    // Slot definitions, attributed to their owning powerup rem id so we can tell
    // "CardPriority#aaa.Priority" from "CardPriority#bbb.Priority".
    const slotById = new Map();
    hr('5. SLOT DEFINITIONS');
    for (const r of rems) {
      if (!SLOTS.includes(textOf(r).trim().toLowerCase())) continue;
      const owner = F.parent ? byId.get(r[F.parent]) : undefined;
      const ownerName = owner ? textOf(owner) : '(no parent)';
      const ownerId = owner ? idOf(owner) : null;
      slotById.set(idOf(r), { name: textOf(r), ownerName, ownerId });
      say(`  "${textOf(r)}"  id=${idOf(r)}  owner="${ownerName}"#${String(ownerId).slice(0, 6)}`);
    }

    // ── 6. The document itself ─────────────────────────────────────────────
    if (!MATCH) { hr('6. SKIPPED — set MATCH to probe a document'); return finish(); }

    hr(`6. DOCUMENT MATCHING "${MATCH}"`);
    const needle = MATCH.toLowerCase();
    const roots = rems.filter((r) => textOf(r).toLowerCase().includes(needle));
    say(`Matching rems: ${roots.length}`);
    if (!roots.length) { say('Nothing matched — try a shorter MATCH.'); return finish(); }

    const seen = new Set();
    const walk = (rem, depth) => {
      if (!rem || seen.has(idOf(rem))) return;
      seen.add(idOf(rem));

      // Tags, with their ids, so two same-named tags are distinguishable.
      const tags = ids(rem, F.tags).map((i) => {
        const t = byId.get(i);
        return `${t ? textOf(t) : '?'}#${String(i).slice(0, 6)}`;
      });

      // Property values are CHILD rems tagged with a slot-definition rem.
      const props = [];
      for (const cid of ids(rem, F.children)) {
        const child = byId.get(cid);
        if (!child) continue;
        for (const tid of ids(child, F.tags)) {
          const s = slotById.get(tid);
          if (!s) continue;
          props.push(
            `${s.ownerName}#${String(s.ownerId).slice(0, 6)}.${s.name} = ` +
            JSON.stringify(textOf(child)).slice(0, 120)
          );
        }
      }

      if (tags.length || props.length) {
        const pad = '  '.repeat(depth);
        say(`${pad}• ${textOf(rem).slice(0, 60)}   [${idOf(rem)}]`);
        if (tags.length) say(`${pad}    tags:   ${tags.join(', ')}`);
        if (props.length) say(`${pad}    VALUES: ${props.join(' ; ')}`);
        if (!props.length) say(`${pad}    VALUES: (none)`);
      }
      for (const cid of ids(rem, F.children)) walk(byId.get(cid), depth + 1);
    };
    for (const r of roots) walk(r, 0);

    hr('HOW TO READ THIS');
    say('Per card, read the VALUES line:');
    say('  CardPriority#xxx.Priority = "2"  -> the value IS in this KB.');
    say('  VALUES: (none)                   -> the value is not here at all.');
    say('');
    say('Then compare the #id after each powerup name against section 4:');
    say('  value on the SAME powerup the plugin registered -> plugin overwrote it');
    say('  value on a DIFFERENT same-named powerup         -> import duplicated the');
    say('    powerup; the value is intact but unreachable by code, and the fix is a');
    say('    migration that re-points it, not a change to any write path.');
    say('');
    say('Run this in the SOURCE KB too — the difference is what the transfer lost.');
    return finish();
  } catch (err) {
    hr('PROBE FAILED');
    say(String(err && err.stack ? err.stack : err));
    return finish();
  }
})();
