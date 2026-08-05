/**
 * One-time seed of user settings out of RemNote's settings panel and into the
 * plugin's own synced storage, plus a durable, inspectable record of how that
 * went for every individual setting.
 *
 * Why it has to happen while the registrations still exist: `getSetting`
 * resolves a setting through its *registration record* and reads `defaultValue`
 * off it. For an unregistered id it throws
 * `TypeError: Cannot read properties of undefined (reading 'defaultValue')`
 * rather than returning `undefined`. So once register/settings.ts stops
 * registering a setting, its stored value is unreadable forever. Every user must
 * therefore pass through at least one activation that both registers the legacy
 * settings AND runs this seed — which is why the registrations are gated on the
 * migration flag instead of being deleted outright.
 *
 * The seed is merge-only and idempotent: it never overwrites a key already in
 * the values blob, so a second device (or a re-run) cannot clobber changes the
 * user has since made. It stores only settings whose value differs from the
 * default — see the note in the loop for why.
 */
import { RNPlugin } from '@remnote/plugin-sdk';
import { IE_POPUP_TIER_IDS, IE_SETTINGS_DEFAULTS, IESettingId, IESettings } from './settings';
import {
  ieSettingsValuesKey,
  ieSettingsMigratedKey,
  ieSettingsMigrationReportKey,
  enableMasteryDrillId,
  legacySkipMasteryDrillId,
} from './consts';

export { ieSettingsValuesKey, ieSettingsMigratedKey, ieSettingsMigrationReportKey };

/**
 * Bump when the stored blob must be refreshed from the registrations.
 *
 * A version rather than a boolean because a seed can ship before the release
 * that reads from the blob: in between, users keep changing settings in
 * RemNote's panel, and a merge-only re-run would not pick those up. Bumping
 * forces one fresh re-read so nobody is left with stale values.
 *
 * v1: initial seed, while RemNote's settings panel was still the live backend.
 * v2: store only values that differ from the default, so that editing a default
 *     still reaches users who never customised that setting.
 * v3: seed popup-tier settings only — native-tier ones stay in RemNote's panel
 *     and are read from there, so storing them would just go stale.
 * v4: skip_mastery_drill moved native -> popup. A KB seeded at v3 has no blob
 *     entry for it (it was native then), so without a re-seed its stored value
 *     in RemNote's panel would be ignored in favour of the default. ANY tier
 *     change from native to popup needs a bump for exactly this reason.
 * v5: skip_mastery_drill renamed and inverted to enable-mastery-drill, so the
 *     opt-in reads positively like the flashcard-prioritisation gate. Handled by
 *     LEGACY_CONVERSIONS below — a rename alone would silently reset the value.
 */
export const SEED_VERSION = 5;

/**
 * Settings that changed id or polarity, and how to carry the old value across.
 *
 * A plain rename loses the value: the new id has nothing stored, so it resolves
 * to its default. Each entry reads the old key out of the blob, transforms it
 * and writes it under the new id, then drops the old key.
 *
 * Idempotent by construction — once the old key is gone there is nothing to
 * convert, so a re-run (or a forced re-seed) does nothing.
 */
const LEGACY_CONVERSIONS: Array<{
  legacyId: string;
  newId: IESettingId;
  convert: (legacyValue: unknown) => unknown;
  note: string;
}> = [
  {
    legacyId: legacySkipMasteryDrillId,
    newId: enableMasteryDrillId,
    convert: (v) => !v,
    note: 'skip_mastery_drill -> enable-mastery-drill (inverted)',
  },
];

/** Give up retrying after this many activations, so a permanently unreadable
 *  setting cannot make every boot re-run the seed forever. */
const MAX_MIGRATION_ATTEMPTS = 3;

export type SettingMigrationStatus =
  /** Read a stored value that differs from the default — a real user choice carried over. */
  | 'migrated'
  /** Read successfully, but equals the default — deliberately NOT stored, so the
   *  setting keeps resolving through IE_SETTINGS_DEFAULTS. */
  | 'default'
  /** Already in the values blob from an earlier run; left untouched. */
  | 'already-present'
  /** Carried over from a renamed or inverted predecessor id. */
  | 'converted'
  /** `getSetting` threw. Nothing was written; reads fall back to the default. */
  | 'failed';

export interface SettingMigrationRecord {
  id: IESettingId;
  status: SettingMigrationStatus;
  /** The effective value: what is in the blob, or the default when nothing is stored. */
  value: unknown;
  /** The default for this setting, for comparison when reading the report. */
  defaultValue: unknown;
  error?: string;
}

export interface SettingsMigrationReport {
  startedAt: number;
  finishedAt: number;
  /** The SEED_VERSION this run was performed at. */
  seedVersion: number;
  /** How many times the seed has run, including this one. */
  attempt: number;
  /** True when nothing failed — i.e. every setting is accounted for in the blob. */
  complete: boolean;
  /** True when we stopped retrying despite failures (attempt limit reached). */
  gaveUp: boolean;
  total: number;
  counts: Record<SettingMigrationStatus, number>;
  records: SettingMigrationRecord[];
}

const LOG = '[IESettingsMigration]';

/**
 * Reads the stored values blob. Exported so the eventual settings backend and
 * the debug widget can both see exactly what the seed produced.
 */
export async function getIESettingsValues(
  plugin: RNPlugin
): Promise<Partial<IESettings>> {
  return (await plugin.storage.getSynced<Partial<IESettings>>(ieSettingsValuesKey)) || {};
}

/**
 * The seed version this knowledge base last completed, or 0 if none has.
 * Older builds wrote `true` here rather than a version number.
 */
export async function getSeededVersion(plugin: RNPlugin): Promise<number> {
  const raw = await plugin.storage.getSynced<number | boolean>(ieSettingsMigratedKey);
  return raw === true ? 1 : typeof raw === 'number' ? raw : 0;
}

/**
 * Whether the legacy popup-tier settings still need to be registered with
 * RemNote on this activation. `getSetting` throws for an unregistered id, so a
 * knowledge base that has not reached the current seed version can only be read
 * while those registrations are live.
 *
 * Deliberately not gated on the retry budget: registering is cheap, and a KB
 * whose seed keeps failing must not also lose the ability to read its values.
 */
export async function isIESettingsSeedNeeded(plugin: RNPlugin): Promise<boolean> {
  return (await getSeededVersion(plugin)) < SEED_VERSION;
}

/** Reads the last migration report, or null if the seed has never run. */
export async function getIESettingsMigrationReport(
  plugin: RNPlugin
): Promise<SettingsMigrationReport | null> {
  return (
    (await plugin.storage.getSynced<SettingsMigrationReport>(ieSettingsMigrationReportKey)) ||
    null
  );
}

/** Human-readable rendering of a report — used for the console dump and the clipboard export. */
export function formatMigrationReport(report: SettingsMigrationReport | null): string {
  if (!report) {
    return `${LOG} no migration has run yet on this knowledge base.`;
  }
  const lines: string[] = [];
  lines.push('========== IE SETTINGS MIGRATION REPORT ==========');
  lines.push(`Run at:    ${new Date(report.finishedAt).toLocaleString()} (attempt ${report.attempt})`);
  lines.push(`Status:    ${report.complete ? 'COMPLETE' : report.gaveUp ? 'INCOMPLETE — gave up after retries' : 'INCOMPLETE — will retry on next reload'}`);
  lines.push(
    `Settings:  ${report.total} total | ${report.counts.migrated} carried over | ` +
      `${report.counts.default} at default | ${report.counts['already-present']} already stored | ` +
      `${report.counts.converted} converted | ${report.counts.failed} FAILED`
  );
  lines.push('');
  for (const r of report.records) {
    const flag =
      r.status === 'failed' ? '✗' : r.status === 'converted' ? '~' : r.status === 'migrated' ? '●' : '·';
    lines.push(
      `  ${flag} ${r.id} → ${JSON.stringify(r.value)}` +
        (r.status === 'migrated' || r.status === 'converted'
          ? ` (default ${JSON.stringify(r.defaultValue)})`
          : '') +
        `  [${r.status}]` +
        (r.error ? `\n      ${r.error}` : '')
    );
  }
  lines.push('=================================================');
  return lines.join('\n');
}

/** Prints the stored report to the console. Safe to call at any time. */
export async function logIESettingsMigrationStatus(plugin: RNPlugin): Promise<void> {
  console.log(formatMigrationReport(await getIESettingsMigrationReport(plugin)));
}

/**
 * Seeds the values blob from the currently registered settings and records the
 * outcome per setting.
 *
 * @param plugin Plugin instance.
 * @param opts.force Re-read every setting even if the blob already holds it.
 *   Overwrites blob values — only for the debug widget's explicit re-run.
 * @returns The report that was persisted.
 */
export async function migrateIESettings(
  plugin: RNPlugin,
  opts: { force?: boolean } = {}
): Promise<SettingsMigrationReport> {
  const startedAt = Date.now();
  const previous = await getIESettingsMigrationReport(plugin);
  // Attempts count within a seed version, so a bump restarts the retry budget.
  const attempt = previous && previous.seedVersion === SEED_VERSION ? previous.attempt + 1 : 1;

  const values = await getIESettingsValues(plugin);
  const records: SettingMigrationRecord[] = [];
  // Popup-tier only: native-tier settings keep living in RemNote's panel and are
  // read from there, so a copy in the blob could only ever go stale.
  const ids = IE_POPUP_TIER_IDS;

  // A blob carried over from an earlier seed version may hold native-tier keys.
  // Drop them so the stored state matches what is actually read.
  for (const key of Object.keys(values) as IESettingId[]) {
    if (!ids.includes(key)) {
      delete values[key];
      console.log(`${LOG}   - ${key}: dropped (now managed in RemNote's settings panel)`);
    }
  }

  console.log(`${LOG} starting (attempt ${attempt}, ${ids.length} settings, force=${!!opts.force})`);

  // Renames and polarity flips run first, and win over the main loop below: the
  // new id reads as its own default from the registration, which would overwrite
  // the value we just carried across.
  const converted = new Set<IESettingId>();
  // Limitation: the old value is read from the blob only. A knowledge base that
  // never reached the seed version where the old id lived in the blob has it in
  // RemNote's panel instead, where it is no longer registered and so unreadable
  // — such a KB falls back to the new default.
  for (const conv of LEGACY_CONVERSIONS) {
    const store = values as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(store, conv.legacyId)) continue;

    const legacyValue = store[conv.legacyId];
    const value = conv.convert(legacyValue);
    delete store[conv.legacyId];
    converted.add(conv.newId);

    const defaultValue = IE_SETTINGS_DEFAULTS[conv.newId];
    if (JSON.stringify(value) === JSON.stringify(defaultValue)) {
      delete store[conv.newId];
    } else {
      store[conv.newId] = value;
    }
    records.push({ id: conv.newId, status: 'converted', value, defaultValue });
    console.log(
      `${LOG}   ~ ${conv.note}: ${JSON.stringify(legacyValue)} -> ${JSON.stringify(value)}`
    );
  }

  for (const id of ids) {
    if (converted.has(id)) continue;

    const defaultValue = IE_SETTINGS_DEFAULTS[id];

    if (!opts.force && Object.prototype.hasOwnProperty.call(values, id)) {
      records.push({ id, status: 'already-present', value: values[id], defaultValue });
      console.log(`${LOG}   · ${id}: already stored (${JSON.stringify(values[id])})`);
      continue;
    }

    try {
      const raw = await plugin.settings.getSetting<unknown>(id);
      const value = raw === undefined || raw === null ? defaultValue : raw;
      const isDefault = JSON.stringify(value) === JSON.stringify(defaultValue);

      // Only divergences are stored. Writing a value that equals the default
      // would freeze it: the blob would win over IE_SETTINGS_DEFAULTS forever,
      // so later changes to a default could never reach anyone already seeded.
      // An absent key means "no opinion", which getIESetting resolves through
      // the table — the behaviour we want. The accepted trade-off is that a
      // user who deliberately picked the current default is indistinguishable
      // from one who never touched it, and so follows a future default change.
      if (isDefault) {
        delete (values as Record<string, unknown>)[id];
      } else {
        (values as Record<string, unknown>)[id] = value;
      }

      records.push({ id, status: isDefault ? 'default' : 'migrated', value, defaultValue });
      console.log(
        `${LOG}   ${isDefault ? '·' : '●'} ${id}: ${JSON.stringify(value)}` +
          (isDefault ? ' (default)' : ` (was default ${JSON.stringify(defaultValue)})`)
      );
    } catch (e) {
      // Nothing is written for a failed read: an absent key means getIESetting
      // serves the default, which is the same answer a successful read of an
      // untouched setting would have given.
      records.push({ id, status: 'failed', value: defaultValue, defaultValue, error: String(e) });
      console.warn(`${LOG}   ✗ ${id}: read failed — ${String(e)}`);
    }
  }

  const counts: Record<SettingMigrationStatus, number> = {
    migrated: 0,
    default: 0,
    'already-present': 0,
    converted: 0,
    failed: 0,
  };
  for (const r of records) counts[r.status]++;

  const complete = counts.failed === 0;
  const report: SettingsMigrationReport = {
    startedAt,
    finishedAt: Date.now(),
    seedVersion: SEED_VERSION,
    attempt,
    complete,
    gaveUp: !complete && attempt >= MAX_MIGRATION_ATTEMPTS,
    total: records.length,
    counts,
    records,
  };

  // Values first, flag last: a crash in between re-runs the seed harmlessly
  // rather than marking a partial migration as done.
  await plugin.storage.setSynced(ieSettingsValuesKey, values);
  await plugin.storage.setSynced(ieSettingsMigrationReportKey, report);
  if (complete) {
    await plugin.storage.setSynced(ieSettingsMigratedKey, SEED_VERSION);
  }

  console.log(formatMigrationReport(report));
  return report;
}

/**
 * Runs the seed on activation unless it has already completed. Called from
 * onActivate immediately after registerPluginSettings — the registrations must
 * be live for the reads to work.
 */
export async function migrateIESettingsIfNeeded(plugin: RNPlugin): Promise<void> {
  const doneVersion = await getSeededVersion(plugin);

  if (doneVersion >= SEED_VERSION) {
    return;
  }

  const previous = await getIESettingsMigrationReport(plugin);
  // Retry budget applies per seed version: a version bump gets a fresh three.
  if (
    previous &&
    previous.seedVersion === SEED_VERSION &&
    previous.attempt >= MAX_MIGRATION_ATTEMPTS
  ) {
    console.warn(
      `${LOG} skipping: ${previous.counts.failed} setting(s) still unreadable after ` +
        `${previous.attempt} attempts. Re-run manually from the debug widget if needed.`
    );
    return;
  }

  // A KB seeded at an older version is re-read in full: values changed in
  // RemNote's settings panel since that seed would otherwise be lost.
  const force = doneVersion > 0;
  if (force) {
    console.log(`${LOG} re-seeding: stored version ${doneVersion} < ${SEED_VERSION}`);
  }
  await migrateIESettings(plugin, { force });
}
