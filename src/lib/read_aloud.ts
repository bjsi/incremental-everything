/**
 * "Read aloud": the focused rem and its descendants, in tree order, become a spoken
 * script; the Local Media Bridge helper turns it into an mp3 (POST /tts, which runs
 * scripts/media_bridge/tts.py: Gemini TTS one call per language block, or Azure's
 * multilingual voice when the script has many inline foreign terms, or ElevenLabs;
 * the user picks among the engines whose keys the helper has); the mp3 is
 * stored in RemNote as an audio rem, first child of the read rem.
 *
 * The plugin only reads and inserts. The API keys stay in the helper's .env; the
 * popup (widgets/read_aloud_popup) shows the script for editing and the helper's
 * free estimate (POST /tts/plan) before anything is paid for.
 *
 * Reading rules (plans/AI_STUDY_TOOLS_PLAN.md, Phase A): powerup properties and
 * slots, images, drawings, audio, embeds, pins and tags are skipped; a reference
 * reads the text it shows (its alias when it points at one); a formula is skipped
 * with "formula omitted"; a table with "table omitted"; existing audio rems and
 * everything under them are never read; italic words in the other language get
 * inline language marks (<en>…</en> in a Portuguese line, <pt>…</pt> in an English
 * one), which is also what sends a script to the multilingual voice.
 */
import {
  BuiltInPowerupCodes,
  ReactRNPlugin,
  RichTextInterface,
  RNPlugin,
  SelectionType,
} from '@remnote/plugin-sdk';
import {
  mediaBridgeEnabledId,
  pendingReadAloudJobsKey,
  READ_ALOUD_POPUP,
  readAloudTagId,
} from './consts';
import { MEDIA_BRIDGE_URL } from './media_bridge';
import { runAudio } from './media_bridge_ops';
import { showMessageDialog } from './message_dialog';
import { showNotice } from './notice';
import { resolvePriorityTargets } from './priority_targets';
import { PRONUNCIATION_CAPTION_COLOR, PRONUNCIATION_POWERUP_CODE } from './pronunciation_css';
import { buildReadAloudScript, buildRemScript, Lang, ReadAloudStats } from './read_aloud_script';
import { getIESetting } from './settings';

export type { Lang, ReadAloudStats };

/** The helper version with /tts/write (Adapted, Summary), ElevenLabs, /tts/play and the pronunciation folder. */
const MIN_HELPER_VERSION = 12;
export interface ReadAloudContext {
  remId: string;
  title: string;
  lang: Lang;
  /** The Literal script. */
  script: string;
  /** The tree as an outline (formulas as LaTeX), for the LLM modes. */
  source: string;
  stats: ReadAloudStats;
}

export type ReadAloudMode = 'literal' | 'adapted' | 'summary';

/** What inserting the audio needs of the context: where it goes and in which language. */
export type ReadAloudTarget = Pick<ReadAloudContext, 'remId' | 'title' | 'lang'>;

/** What the helper's LLM step (/tts/write) returns. */
export interface WriteResult {
  ok: boolean;
  message?: string;
  script?: string;
  errors?: string[];
  via?: 'claude-cli' | 'anthropic-api';
  model?: string;
  costUsd?: number;
  fallbackReason?: string;
  seconds?: number;
  words?: number;
  targetWords?: number | null;
  /** Added by the popup: when, and from which version of the note (sourceHash). */
  writtenAt?: number;
  sourceHash?: string;
}

/** One TTS engine as the helper reports it: available = its API keys are set. */
export interface TtsEngine {
  id: string;
  label: string;
  available: boolean;
  missing: string[];
  voices: string[];
  /** How it treats the <pt>/<en> marks ('' when the script has none). */
  note: string;
  estSeconds: number;
  estCostUsd: number;
  /** Measured speech rate of this engine, pauses excluded. */
  wordsPerMinute?: number;
}

export interface TtsPlan {
  ok: boolean;
  errors?: string[];
  /** The planned engine: the requested one, or the suggestion for 'auto'. */
  engine?: string;
  suggested?: string | null;
  engines?: TtsEngine[];
  /** The planned engine's keys are set. */
  ready?: boolean;
  missing?: string[];
  note?: string;
  voice?: string | null;
  voices?: string[];
  characters?: number;
  words?: number;
  inlineTerms?: number;
  calls?: number;
  answerPauses?: number[];
  estSeconds?: number;
  estCostUsd?: number;
  title?: string;
}

export interface TtsResult {
  ok: boolean;
  message?: string;
  engine?: string;
  voice?: string;
  voiceLabel?: string;
  seconds?: number;
  characters?: number;
  audioTokens?: number;
  costUsd?: number;
  url?: string;
  saved?: string;
}

export interface TtsTask<R = TtsResult> {
  id: string;
  status: 'running' | 'done';
  stage: string;
  elapsed: number;
  result: R | null;
}

// --- helper -------------------------------------------------------------------------

async function helperProblem(): Promise<string | undefined> {
  try {
    const res = await fetch(`${MEDIA_BRIDGE_URL}/health`);
    const health = await res.json();
    if ((health?.version ?? 1) < MIN_HELPER_VERSION) {
      return (
        `The media-bridge helper running on this computer is version ${health?.version ?? 1}; ` +
        `Read aloud needs ${MIN_HELPER_VERSION}. Restart it: curl -X POST localhost:3460/shutdown, then ` +
        'launchctl kickstart -k gui/$(id -u)/com.incrementalremnote.media-bridge'
      );
    }
    return undefined;
  } catch {
    return (
      `The media-bridge helper is not reachable at ${MEDIA_BRIDGE_URL}. Start it with ` +
      'scripts/media_bridge/media_bridge.py start (or load its launchd agent).'
    );
  }
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${MEDIA_BRIDGE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error ?? `helper answered ${res.status}`);
  return json as T;
}

export const planTts = (script: string, engine: string, voice: string | null = null) =>
  postJSON<TtsPlan>('/tts/plan', { script, engine, voice });

export async function startTts(
  script: string,
  engine: string,
  voice: string | null,
  remId: string,
  subject: string,
  /** 'pronunciation' keeps the helper's copy in its own folder. */
  purpose: 'read-aloud' | 'pronunciation' = 'read-aloud'
): Promise<string> {
  const body = await postJSON<{ taskId?: string }>('/tts', {
    script,
    engine,
    voice,
    remId,
    subject,
    purpose,
  });
  if (!body.taskId) throw new Error('the helper started no task');
  return body.taskId;
}

export async function getTtsTask<R = TtsResult>(taskId: string): Promise<TtsTask<R>> {
  const res = await fetch(`${MEDIA_BRIDGE_URL}/tts/${taskId}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `helper answered ${res.status}`);
  return body as TtsTask<R>;
}

/** Ask the helper's LLM step to write the Adapted or Summary script; returns the task id. */
export async function startWrite(
  context: ReadAloudContext,
  mode: 'adapted' | 'summary',
  targetWords: number | null,
  instructions: string
): Promise<string> {
  const body = await postJSON<{ taskId?: string }>('/tts/write', {
    mode,
    source: context.source,
    lang: context.lang,
    title: context.title,
    remId: context.remId,
    targetWords,
    instructions,
  });
  if (!body.taskId) throw new Error('the helper started no task');
  return body.taskId;
}

// --- insert -------------------------------------------------------------------------

/** Store the mp3 in RemNote as the first child of the read rem, and tag it if the setting says so. */
export async function insertAudio(
  plugin: RNPlugin,
  context: ReadAloudTarget,
  result: TtsResult,
  mode: ReadAloudMode = 'literal'
): Promise<{ remId?: string; warning?: string }> {
  if (!result.url) throw new Error('No audio file came back.');
  const pt = context.lang === 'pt';
  const word =
    mode === 'summary' ? (pt ? 'Resumo em Áudio' : 'Audio Summary') : pt ? 'Áudio' : 'Audio';
  const caption = `🔊 ${word} (${result.voiceLabel ?? result.voice ?? 'TTS'})`;
  return placeAudio(plugin, context.remId, result.url, caption);
}

/**
 * The audio rem: stored in RemNote, first child of `parentId`. A Read aloud audio gets
 * the optional tag setting; a pronunciation instead gets the Extra Card Detail and
 * Pronunciation powerups (its own mark, lib/pronunciation_css), kept apart.
 */
async function placeAudio(
  plugin: RNPlugin,
  parentId: string,
  url: string,
  caption: string,
  pronunciation = false
): Promise<{ remId?: string; warning?: string }> {
  // runAudio only uses RNPlugin calls; it is typed for the bridge's ReactRNPlugin.
  const placed = await runAudio(plugin as ReactRNPlugin, {
    id: `read-aloud-${Date.now()}`,
    op: 'audio',
    remIds: [parentId],
    url,
    caption,
    position: 'first',
  });
  const remId = typeof placed.remId === 'string' ? placed.remId : undefined;
  if (!placed.ok && !remId) throw new Error(placed.summary);
  let warning = placed.ok ? undefined : placed.summary;
  const addWarning = (w: string) => (warning = warning ? `${warning}; ${w}` : w);

  if (pronunciation) {
    const audioRem = remId ? await plugin.rem.findOne(remId) : undefined;
    for (const [code, label] of [
      [BuiltInPowerupCodes.ExtraCardDetail, 'Extra Card Detail'],
      [PRONUNCIATION_POWERUP_CODE, 'Pronunciation'],
    ] as const) {
      try {
        await audioRem?.addPowerup(code);
      } catch (err) {
        addWarning(`${label} not set (${String(err)})`);
      }
    }
    // The 🔊 caption in a text colour (invisible on an emoji): a lone Extra details item
    // in the queue carries no tags, so the CSS finds a pronunciation by it.
    try {
      const text = audioRem?.text ?? [];
      if (typeof text[0] === 'string') {
        await audioRem?.setText([
          { i: 'm', text: text[0], tc: PRONUNCIATION_CAPTION_COLOR },
          ...text.slice(1),
        ] as RichTextInterface);
      }
    } catch (err) {
      addWarning(`caption colour not set (${String(err)})`);
    }
    return { remId, warning };
  }

  const tagName = String((await getIESetting(plugin, readAloudTagId)) ?? '').trim();
  if (tagName && remId) {
    try {
      let tag = await plugin.rem.findByName([tagName], null);
      if (!tag) {
        tag = await plugin.rem.createRem();
        await tag?.setText([tagName]);
      }
      const audioRem = await plugin.rem.findOne(remId);
      if (tag && audioRem) await audioRem.addTag(tag._id);
    } catch (err) {
      addWarning(`tag “${tagName}” not added (${String(err)})`);
    }
  }
  return { remId, warning };
}

/** A script line → rich text: language prefix dropped, <en>/<pt> terms in italics. */
function scriptLineToRichText(line: string): RichTextInterface {
  const text = line.replace(/^\[(pt|en)\]\s*/, '');
  const out: RichTextInterface = [];
  let pos = 0;
  for (const m of text.matchAll(/<(pt|en)>(.*?)<\/\1>/g)) {
    if (m.index! > pos) out.push(text.slice(pos, m.index));
    out.push({ i: 'm', text: m[2], l: true });
    pos = m.index! + m[0].length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

/**
 * The summary's text under the audio rem: a first child saying what it is, then one
 * rem per script line ([pause] lines left out).
 */
export async function insertSummaryText(
  plugin: RNPlugin,
  audioRemId: string,
  context: ReadAloudTarget,
  script: string,
  model?: string
): Promise<void> {
  const audioRem = await plugin.rem.findOne(audioRemId);
  if (!audioRem) throw new Error('the audio rem is gone');
  const by = model ? ` (${model})` : '';
  const header =
    context.lang === 'pt'
      ? `Resumo deste documento, escrito por IA${by}:`
      : `Summary of this document, written by AI${by}:`;
  const lines = [
    header,
    ...script
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^\[(pause|pausa)(\s+[\d.,]+)?\]$/i.test(l)),
  ];
  for (const [i, line] of lines.entries()) {
    const rem = await plugin.rem.createRem();
    if (!rem) throw new Error('could not create a rem');
    await rem.setText(i === 0 ? [line] : scriptLineToRichText(line));
    await rem.setParent(audioRem, i);
  }
}

/** 75 → "1 min 15 s"; 40 → "40 s". */
export const minutes = (s: number) => {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m} min ${r.toString().padStart(2, '0')} s` : `${r} s`;
};

/** Words a script will speak: language prefixes, marks and [pause] lines left out. */
export function scriptWords(script: string): number {
  return script
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\[(pause|pausa)(\s+[\d.,]+)?\]$/i.test(l))
    .map((l) => l.replace(/^\[(pt|en)\]\s*/, '').replace(/<\/?(pt|en)>/g, ''))
    .reduce((n, l) => n + l.split(/\s+/).filter(Boolean).length, 0);
}

// --- background jobs ----------------------------------------------------------------

/**
 * A Generate handed off by the popup: the helper is already synthesising (taskId); the
 * tracker (register/tracker.ts, in the persistent index widget) waits for the mp3,
 * inserts it, and reports with a message dialog. The popup closes as soon as the job is
 * queued, so a long script no longer holds it open, and closing it no longer loses the
 * audio. Lives in this window's session: a reload of RemNote while it runs drops the job
 * (the helper still keeps its copy of the mp3).
 */
export interface ReadAloudJob {
  /** Unique per Generate, so a job the tracker reads twice runs once. */
  id: string;
  taskId: string;
  target: ReadAloudTarget;
  mode: ReadAloudMode;
  /** The Summary script, to insert as text under the audio when asked for. */
  summaryText?: string;
  summaryModel?: string;
  queuedAt: number;
}

/** Waiting stops after this long, or after this many failed polls in a row. */
const JOB_TIMEOUT_MS = 60 * 60_000;
const JOB_MAX_POLL_FAILURES = 10;
const JOB_POLL_MS = 2000;

export async function enqueueReadAloudJob(plugin: RNPlugin, job: ReadAloudJob): Promise<void> {
  const queue = (await plugin.storage.getSession<ReadAloudJob[]>(pendingReadAloudJobsKey)) || [];
  await plugin.storage.setSession(pendingReadAloudJobsKey, [...queue, job]);
}

async function waitForJob(taskId: string): Promise<TtsResult> {
  const until = Date.now() + JOB_TIMEOUT_MS;
  let failures = 0;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    try {
      const task = await getTtsTask(taskId);
      failures = 0;
      if (task.status === 'done') return task.result ?? { ok: false, message: 'no result' };
    } catch (err) {
      // A helper restart forgets its tasks: that answer repeats, a network blip does not.
      if (++failures >= JOB_MAX_POLL_FAILURES) {
        return { ok: false, message: `lost contact with the helper (${String(err)})` };
      }
    }
  }
  return { ok: false, message: `the helper took more than ${JOB_TIMEOUT_MS / 60_000} minutes` };
}

/** Wait for the helper's audio, insert it (and the summary text), and say how it went. */
export async function runReadAloudJob(plugin: RNPlugin, job: ReadAloudJob): Promise<void> {
  const name = job.target.title || 'Untitled rem';
  // Notices, not message dialogs: the job ends at a moment the user did not choose,
  // maybe while another Read Aloud popup is writing its script.
  const fail = (message: string) =>
    showNotice(plugin, {
      title: 'Read aloud: no audio added',
      message: `“${name}”: ${message}`,
      tone: 'error',
    });
  try {
    const result = await waitForJob(job.taskId);
    if (!result.ok) {
      await fail(result.message ?? 'the helper failed');
      return;
    }
    const { remId, warning } = await insertAudio(plugin, job.target, result, job.mode);
    const notes = warning ? [warning] : [];
    if (job.summaryText && remId) {
      try {
        await insertSummaryText(plugin, remId, job.target, job.summaryText, job.summaryModel);
      } catch (err) {
        notes.push(`summary text not inserted (${String(err)})`);
      }
    }
    const cost = result.costUsd != null ? `, ~US$${result.costUsd.toFixed(2)}` : '';
    await showNotice(plugin, {
      title: job.mode === 'summary' ? 'Audio summary added' : 'Audio added',
      message:
        `“${name}”: ${result.voiceLabel ?? result.voice ?? 'TTS'}, ` +
        `${minutes(result.seconds ?? 0)}${cost}. It is the first child of the rem.`,
      detail: notes.length ? notes.join('; ') : undefined,
      tone: notes.length ? 'info' : 'success',
      // The read Rem: the audio sits at its top, as the first child.
      openRemId: job.target.remId,
    });
  } catch (err) {
    console.error('[ReadAloud] background job failed', err);
    await fail(String(err));
  }
}

// --- drafts (per rem, this device) -------------------------------------------------

/**
 * What the popup keeps for a rem between openings: the AI-written scripts (with how
 * they were written and from which version of the note), a hand-edited Literal script,
 * and the Summary options. In the plugin's local storage (this device, not synced, kept
 * across restarts); the most recent MAX_DRAFTS rems only.
 */
export interface ReadAloudDraft {
  savedAt: number;
  mode: ReadAloudMode;
  /** The Literal script as built when it was edited, and the edit. */
  literalBase?: string;
  literal?: string;
  adapted?: string;
  summary?: string;
  written?: Partial<Record<ReadAloudMode, WriteResult>>;
  maxMinutes?: string;
  /** Summary length as a share of the note, in percent. */
  share?: number;
  instructions?: string;
  insertText?: boolean;
}

const DRAFTS_KEY = 'read-aloud-drafts';
const MAX_DRAFTS = 30;

/** A short fingerprint of the note's outline, to tell when it changed since a script was written. */
export function sourceHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}-${text.length}`;
}

export async function loadDraft(
  plugin: RNPlugin,
  remId: string
): Promise<ReadAloudDraft | undefined> {
  try {
    const all = await plugin.storage.getLocal<Record<string, ReadAloudDraft>>(DRAFTS_KEY);
    return all?.[remId];
  } catch {
    return undefined;
  }
}

/** Save (or, with undefined, forget) a rem's draft, keeping the most recent MAX_DRAFTS. */
export async function saveDraft(
  plugin: RNPlugin,
  remId: string,
  draft: ReadAloudDraft | undefined
): Promise<void> {
  const all = {
    ...((await plugin.storage.getLocal<Record<string, ReadAloudDraft>>(DRAFTS_KEY)) ?? {}),
  };
  if (draft) all[remId] = draft;
  else delete all[remId];
  const kept = Object.entries(all)
    .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, MAX_DRAFTS);
  await plugin.storage.setLocal(DRAFTS_KEY, Object.fromEntries(kept));
}

// --- pronunciation (Extra Card Detail) -----------------------------------------------

const PRONOUNCE_TIMEOUT_MS = 120_000;

/** A finished /tts task, polled every second. */
async function waitForTts(taskId: string): Promise<TtsResult> {
  const until = Date.now() + PRONOUNCE_TIMEOUT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    const task = await getTtsTask(taskId);
    if (task.status === 'done') return task.result ?? { ok: false, message: 'no result' };
  }
  return { ok: false, message: 'the helper took more than 2 minutes' };
}

/**
 * Play the new audio at once: in the plugin (RemNote's own audio output), or, when
 * the app refuses to autoplay, through the helper (ffplay / afplay on this computer).
 */
export async function playAudio(url: string): Promise<void> {
  try {
    await new Audio(url).play();
    return;
  } catch (err) {
    console.info('[ReadAloud] in-app playback refused; asking the helper', err);
  }
  try {
    await postJSON('/tts/play', { url });
  } catch (err) {
    console.warn('[ReadAloud] the helper could not play the audio', err);
  }
}

/**
 * "Add pronunciation": the focused or selected Rems (in the queue, the card on screen),
 * front and back only, read aloud with the suggested engine, no popup; the audio goes
 * in as the Rem's first child, captioned 🔊, as Extra Card Detail. A single Rem's audio
 * plays as soon as it is ready.
 */
export async function addPronunciation(plugin: ReactRNPlugin) {
  if (!(await getIESetting(plugin, mediaBridgeEnabledId))) {
    await showMessageDialog(plugin, {
      title: 'Add pronunciation needs the Local Media Bridge',
      message:
        'Turn on the setting "Local Media Bridge" in Incremental Everything. The speech is made by ' +
        'its helper program on this computer, with your own text-to-speech key.',
      tone: 'info',
    });
    return;
  }
  const { remIds } = await resolvePriorityTargets(plugin);
  const rems = remIds.length ? ((await plugin.rem.findMany(remIds)) ?? []) : [];
  if (!rems.length) {
    await plugin.app.toast('No Rem to pronounce: place the cursor in a Rem, or select Rems.');
    return;
  }
  const problem = await helperProblem();
  if (problem) {
    await showMessageDialog(plugin, {
      title: 'Cannot add a pronunciation',
      message: problem,
      tone: 'error',
    });
    return;
  }
  await plugin.app.toast(
    rems.length === 1 ? '🔊 Making the pronunciation…' : `🔊 Making ${rems.length} pronunciations…`
  );
  const failures: string[] = [];
  const warnings: string[] = [];
  let done = 0;
  let costUsd = 0;
  for (const rem of rems) {
    const built = await buildRemScript(plugin, rem);
    const label = built.title.slice(0, 40) || rem._id;
    if (!built.script.trim()) {
      failures.push(`“${label}”: no text to read`);
      continue;
    }
    try {
      const plan = await planTts(built.script, 'auto');
      if (!plan.ok || !plan.ready || !plan.engine) {
        failures.push(`“${label}”: ${(plan.errors ?? plan.missing ?? ['no engine']).join('; ')}`);
        continue;
      }
      const taskId = await startTts(
        built.script,
        plan.engine,
        null,
        rem._id,
        built.title,
        'pronunciation'
      );
      const result = await waitForTts(taskId);
      if (!result.ok || !result.url) {
        failures.push(`“${label}”: ${result.message ?? 'no audio'}`);
        continue;
      }
      if (rems.length === 1) void playAudio(result.url);
      const placed = await placeAudio(plugin, rem._id, result.url, '🔊', true);
      if (placed.warning) warnings.push(placed.warning);
      costUsd += result.costUsd ?? 0;
      done++;
    } catch (err) {
      failures.push(`“${label}”: ${String(err)}`);
    }
  }
  if (failures.length) {
    await showMessageDialog(plugin, {
      title: done
        ? `Pronunciation added to ${done} of ${rems.length} Rems`
        : 'No pronunciation added',
      message: [...failures, ...warnings].join('\n'),
      tone: 'error',
    });
    return;
  }
  await plugin.app.toast(
    `🔊 Pronunciation added${done > 1 ? ` to ${done} Rems` : ''} (~US$${costUsd.toFixed(3)})` +
      (warnings.length ? ` — ${warnings.join('; ')}` : '')
  );
}

// --- the command --------------------------------------------------------------------

export async function openReadAloud(plugin: RNPlugin) {
  if (!(await getIESetting(plugin, mediaBridgeEnabledId))) {
    await showMessageDialog(plugin, {
      title: 'Read aloud needs the Local Media Bridge',
      message:
        'Turn on the setting "Local Media Bridge" in Incremental Everything. The speech is made by ' +
        'its helper program on this computer, with your own Gemini or Azure key.',
      tone: 'info',
    });
    return;
  }
  const selection = await plugin.editor.getSelection();
  const rem =
    selection?.type === SelectionType.Rem
      ? await plugin.rem.findOne(selection.remIds[0])
      : await plugin.focus.getFocusedRem();
  if (!rem) {
    await plugin.app.toast('No focused rem — place your cursor in the rem (or document) to read.');
    return;
  }
  const problem = await helperProblem();
  if (problem) {
    await showMessageDialog(plugin, {
      title: 'Cannot read aloud',
      message: problem,
      tone: 'error',
    });
    return;
  }
  await plugin.app.toast('Reading the rem tree…');
  const built = await buildReadAloudScript(plugin, rem);
  if (!built.script.trim()) {
    await plugin.app.toast('Nothing to read in this rem.');
    return;
  }
  const context: ReadAloudContext = { remId: rem._id, ...built };
  await plugin.widget.openPopup(READ_ALOUD_POPUP, context);
}
