#!/usr/bin/env node
/*
 * analyze_rem_export.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reports whether a RemNote export file carries Incremental / CardPriority data.
 *
 *     node scripts/analyze_rem_export.js <path-to-export> [match-text]
 *
 * This is the export-side counterpart to scripts/remnote_powerup_probe.js. The
 * probe tells you what is in a knowledge base; this tells you what left the
 * source KB in the file. Between them they localise the loss to one of three
 * places: the export, the import, or the plugin after import.
 *
 * Neither RemNote nor the plugin is involved, so nothing here can be blamed for
 * mutating the data. Read-only: the file is opened for reading and never written.
 *
 * Handles .rem / .json / .zip / .gz, and does not assume a schema — it walks the
 * parsed JSON looking for arrays of rem-like records and reports what it found.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const POWERUP_NAMES = new Set(['cardpriority', 'incremental']);
const SLOT_NAMES = new Set([
  'priority', 'priority source', 'last updated',   // CardPriority
  'next rep date', 'history', 'created',           // Incremental
]);

const file = process.argv[2];
const match = process.argv[3] ? process.argv[3].toLowerCase() : null;

if (!file) {
  console.error('Usage: node scripts/analyze_rem_export.js <export-file> [match-text]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}

const hr = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);

// ── Load and parse, tolerating the container formats RemNote uses ───────────
function loadJson(p) {
  const raw = fs.readFileSync(p);

  // gzip
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    return JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  }
  // zip — shell out to unzip rather than adding a dependency
  if (raw[0] === 0x50 && raw[1] === 0x4b) {
    const names = execFileSync('unzip', ['-Z1', p], { encoding: 'utf8' }).trim().split('\n');
    console.log(`Zip archive containing:\n  ${names.join('\n  ')}`);
    const entry = names.find((n) => /\.(json|rem)$/i.test(n)) || names[0];
    console.log(`Reading entry: ${entry}`);
    return JSON.parse(execFileSync('unzip', ['-p', p, entry], { encoding: 'utf8', maxBuffer: 1 << 30 }));
  }
  return JSON.parse(raw.toString('utf8'));
}

let data;
try {
  data = loadJson(file);
} catch (e) {
  hr('COULD NOT PARSE');
  console.log(`${path.basename(file)} is not JSON/gzip/zip we can read: ${e.message}`);
  console.log('First 400 bytes:');
  console.log(fs.readFileSync(file).slice(0, 400).toString('utf8'));
  process.exit(1);
}

hr(`1. FILE STRUCTURE — ${path.basename(file)}`);
console.log('Top-level type:', Array.isArray(data) ? `array[${data.length}]` : typeof data);
if (!Array.isArray(data)) console.log('Top-level keys:', Object.keys(data).join(', '));

// ── Find the array of rem records, wherever it lives ────────────────────────
const remLike = (o) =>
  o && typeof o === 'object' && (o._id || o.id) &&
  Object.keys(o).some((k) => /^(key|text|children|parent|tags?)/i.test(k));

let rems = null;
let where = '';
(function findRems(node, pathStr, depth) {
  if (rems || depth > 4 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    if (node.length && node.filter(remLike).length >= Math.min(3, node.length)) {
      rems = node.filter(remLike);
      where = pathStr || '(root)';
    }
    return;
  }
  for (const [k, v] of Object.entries(node)) findRems(v, pathStr ? `${pathStr}.${k}` : k, depth + 1);
})(data, '', 0);

if (!rems) {
  hr('NO REM ARRAY FOUND');
  console.log('Dumping the top-level shape so the script can be retargeted:');
  console.log(JSON.stringify(data, null, 2).slice(0, 3000));
  process.exit(1);
}
console.log(`Rem records: ${rems.length}  (found at: ${where})`);
console.log('\nSample record:');
console.log(JSON.stringify(rems[0], null, 2).slice(0, 1200));

// ── RemNote's native export schema ─────────────────────────────────────────
//
// Learned by inspecting a real export rather than guessed. The fields that matter:
//
//   key            rich text (array of strings / ref objects)
//   parent, ch     parent id, children ids
//   tp             TAGS ("type parents"): an OBJECT keyed by the tag rem's id
//   apu            ACTIVE POWERUPS: an object keyed by powerup CODE, e.g.
//                    { cardPriority: {v:true}, incremental: {v:true} }
//   ps             POWERUP SLOT VALUES: an object keyed by `<code>_<slotCode>`:
//                    { cardPriority_priority: { v: { v:["30"], s:"30" } }, … }
//
// The critical consequence: `apu` and `ps` are keyed by powerup CODE, not by the
// powerup rem's id. The export format is therefore portable across knowledge
// bases by construction — a value cannot be "lost because the powerup rem has a
// different id in the target KB". That rules out an entire class of explanation.
const idOf = (r) => r._id ?? r.id;
const byId = new Map(rems.map((r) => [idOf(r), r]));

const textOf = (r) => {
  if (!r) return '';
  const v = r.key ?? r.text;
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

/** Unwraps ps entries: { v: { v: ["30"], s: "30" } } -> "30" */
const slotValue = (entry) => {
  if (entry == null) return null;
  const v = entry.v;
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v.s === 'string') return v.s;
  if (Array.isArray(v.v)) return v.v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('');
  return JSON.stringify(v);
};

const tagIds = (r) => {
  const tp = r.tp;
  if (!tp) return [];
  if (Array.isArray(tp)) return tp.map((x) => (typeof x === 'string' ? x : x?._id)).filter(Boolean);
  return Object.keys(tp);
};
const childIds = (r) => (Array.isArray(r.ch) ? r.ch : []);
const powerupCodes = (r) => (r.apu && typeof r.apu === 'object' ? Object.keys(r.apu) : []);

// ── Powerup definition rems carried by the file ────────────────────────────
hr('2. POWERUP DEFINITION REMS CARRIED BY THE FILE');
const powerups = rems.filter((r) => POWERUP_NAMES.has(textOf(r).trim().toLowerCase()));
if (powerups.length === 0) {
  console.log('None. (Not a problem in itself — `apu`/`ps` reference powerups by code.)');
}
for (const p of powerups) {
  console.log(`  "${textOf(p)}"  id=${idOf(p)}  typeChildren=${(p.typeChildren || []).length} rem(s)`);
}

// ── The payload ────────────────────────────────────────────────────────────
hr('3. INCREMENTAL / CARDPRIORITY VALUES PER REM');
const targets = match ? rems.filter((r) => textOf(r).toLowerCase().includes(match)) : rems;
if (match) console.log(`Filtered to rems matching "${match}": ${targets.length}\n`);

const RELEVANT = /^(cardPriority|incremental)_/;
let withValues = 0;
const summary = [];

for (const r of targets) {
  const codes = powerupCodes(r).filter((c) => /^(cardPriority|incremental)$/.test(c));
  const slots = Object.entries(r.ps || {}).filter(([k]) => RELEVANT.test(k));
  const tags = tagIds(r).map((i) => (byId.get(i) ? textOf(byId.get(i)) : `?${i.slice(0, 6)}`));
  if (codes.length === 0 && slots.length === 0) continue;

  withValues++;
  console.log(`• ${textOf(r).slice(0, 60)}   [${idOf(r)}]`);
  console.log(`    tags (tp):        ${tags.join(', ') || '(none)'}`);
  console.log(`    powerups (apu):   ${codes.join(', ') || '(none)'}`);
  if (slots.length === 0) {
    console.log('    VALUES (ps):      (none) <-- tagged but carrying NO slot value');
  } else {
    for (const [k, v] of slots) {
      const val = slotValue(v);
      const shown = val == null ? '(empty)' : JSON.stringify(val).slice(0, 200);
      console.log(`    ${k} = ${shown}`);
    }
  }
  summary.push({
    rem: textOf(r).slice(0, 40),
    priority: slotValue((r.ps || {}).cardPriority_priority) ?? slotValue((r.ps || {}).incremental_priority) ?? '—',
    source: slotValue((r.ps || {}).cardPriority_prioritySource) ?? '—',
    history: (r.ps || {}).incremental_repHist ? 'yes' : '—',
  });
}

if (summary.length) {
  hr('4. SUMMARY');
  console.table(summary);
}

hr('VERDICT');
if (withValues === 0) {
  console.log('No rem in this file carries a cardPriority/incremental powerup or slot value.');
  console.log('=> Nothing to transfer: the priorities are not in this export.');
} else {
  const tagged = summary.length;
  const valued = summary.filter((s) => s.priority !== '—').length;
  console.log(`${tagged} rem(s) carry one of the powerups; ${valued} carry an actual priority value.`);
  if (valued === 0) {
    console.log('=> Tags present but values absent: whatever produced this file kept the');
    console.log('   powerup and dropped the slot data.');
  } else {
    console.log('=> This file CARRIES the priorities.');
    console.log('');
    console.log('   To find where they are lost, export the SAME document from the target');
    console.log('   KB after importing, and run this script on that file:');
    console.log('     values present in target export -> the import worked; something in');
    console.log('       the KB cleared them afterwards (plugin write path).');
    console.log('     values absent in target export  -> the IMPORT dropped them. Nothing');
    console.log('       in the plugin could have prevented it.');
    console.log('');
    console.log('   That comparison needs no plugin and no IndexedDB access — both sides');
    console.log('   use this same tested script.');
  }
}
