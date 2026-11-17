import '../lib/stall_diagnostics';
import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import {
  enqueueReadAloudJob,
  getTtsTask,
  loadDraft,
  minutes,
  planTts,
  ReadAloudContext,
  ReadAloudDraft,
  ReadAloudMode,
  saveDraft,
  scriptWords,
  sourceHash,
  startTts,
  startWrite,
  TtsEngine,
  TtsPlan,
  WriteResult,
} from '../lib/read_aloud';

const POLL_MS = 1500;
const PLAN_DEBOUNCE_MS = 500;

type Phase =
  | { kind: 'editing' }
  | { kind: 'writing'; stage: string; elapsed: number }
  | { kind: 'starting' }
  | { kind: 'error'; message: string };

const muted = { color: 'var(--rn-clr-content-secondary)' };

const MODES: [ReadAloudMode, string, string][] = [
  ['literal', 'Literal', 'The note as written, with the reading rules. No AI.'],
  [
    'adapted',
    'Adapted',
    'The whole note, made listenable by AI: formulas and units in words, terms marked.',
  ],
  ['summary', 'Summary', 'A spoken summary written by AI, within a maximum length.'],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SAVE_DEBOUNCE_MS = 800;
const DEFAULT_SHARE = 50;
/** Words per minute when the helper has not said yet (Gemini measures ~143). */
const FALLBACK_WPM = 140;

function writtenInfo(w: WriteResult | undefined, currentHash: string | undefined): string {
  if (!w) {
    return "Written with claude -p (your Claude subscription); if that fails, with the Anthropic API key in the helper's .env.";
  }
  const how =
    w.via === 'claude-cli'
      ? 'with claude -p (your subscription)'
      : `with the Anthropic API, ~US$${(w.costUsd ?? 0).toFixed(2)}`;
  const when = w.writtenAt
    ? ` on ${new Date(w.writtenAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
    : '';
  const stale =
    w.sourceHash && currentHash && w.sourceHash !== currentHash
      ? ' The note has changed since: rewrite to include the changes.'
      : '';
  return (
    `Written by ${w.model ?? 'Claude'} ${how}${when}` +
    (w.targetWords ? ` (${w.words ?? '?'} words for a target of ${w.targetWords}).` : '.') +
    (w.fallbackReason ? ` claude -p failed: ${w.fallbackReason}.` : '') +
    stale
  );
}

const SKIP_LABELS: Record<string, string> = {
  images: 'image',
  formulas: 'formula',
  tables: 'table',
  code: 'code block',
  pins: 'pin',
  audio: 'audio',
  drawings: 'drawing',
  embeds: 'embed',
  properties: 'property',
};

/** en-US-AndrewMultilingualNeural → Andrew; Kore → Kore. */
const voiceLabel = (v: string) =>
  v.match(/^[a-z]{2}-[A-Z]{2}-(.+?)(?:Multilingual)?Neural$/)?.[1] ?? v;

function Button({
  label,
  onClick,
  primary,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      className="py-1.5 px-3 text-sm font-medium rounded"
      style={{
        background: primary ? '#3B82F6' : 'var(--rn-clr-background-secondary)',
        color: primary ? 'white' : 'var(--rn-clr-content-primary)',
        border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

const fieldStyle: React.CSSProperties = {
  border: '1px solid var(--rn-clr-border-primary)',
  background: 'var(--rn-clr-background-primary)',
  color: 'var(--rn-clr-content-primary)',
};

/**
 * Read aloud: the script built from the rem tree (lib/read_aloud.ts), editable, with
 * the helper's free estimate; Generate synthesises it (/tts) and adds the audio rem.
 * Modes: Literal (that script), Adapted and Summary (the helper's LLM step, /tts/write,
 * writes the script from the tree's outline; Summary can also insert its text).
 */
export function ReadAloudPopup() {
  const plugin = usePlugin();
  const [context, setContext] = useState<ReadAloudContext | null>(null);
  const [mode, setMode] = useState<ReadAloudMode>('literal');
  // One script per mode, so switching back keeps what was written or edited.
  const [scripts, setScripts] = useState<Record<ReadAloudMode, string>>({
    literal: '',
    adapted: '',
    summary: '',
  });
  const script = scripts[mode];
  const setScript = (text: string) => setScripts((all) => ({ ...all, [mode]: text }));
  const [written, setWritten] = useState<Partial<Record<ReadAloudMode, WriteResult>>>({});
  const [maxMinutes, setMaxMinutes] = useState('5');
  const [share, setShare] = useState(DEFAULT_SHARE);
  const [instructions, setInstructions] = useState('');
  const [insertText, setInsertText] = useState(true);
  const [engine, setEngine] = useState('auto');
  const [voice, setVoice] = useState('');
  const [plan, setPlan] = useState<TtsPlan | null>(null);
  // The helper's engine list, kept while the script has errors (those plans list none).
  const [engines, setEngines] = useState<TtsEngine[]>([]);
  const [lastPlanned, setLastPlanned] = useState('auto');
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const run = useRef(0);
  // Set once the saved draft (if any) is restored; saving starts only then.
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      const data = (ctx?.contextData as ReadAloudContext) ?? null;
      setContext(data);
      const literal = data?.script ?? '';
      const draft = data ? await loadDraft(plugin, data.remId) : undefined;
      setScripts({
        // A hand edit of the Literal script survives only while the note is unchanged.
        literal: draft?.literal && draft.literalBase === literal ? draft.literal : literal,
        adapted: draft?.adapted ?? '',
        summary: draft?.summary ?? '',
      });
      if (draft) {
        setWritten(draft.written ?? {});
        if (draft.maxMinutes) setMaxMinutes(draft.maxMinutes);
        if (draft.share) setShare(draft.share);
        if (draft.instructions) setInstructions(draft.instructions);
        if (draft.insertText !== undefined) setInsertText(draft.insertText);
        if (draft.mode && (draft.mode === 'literal' || draft[draft.mode])) setMode(draft.mode);
      }
      setRestored(true);
    })();
    return () => {
      run.current++; // stop polling when the popup closes
    };
  }, []);

  // Keep this rem's drafts on the device (plugin local storage), debounced.
  useEffect(() => {
    if (!restored || !context) return;
    const timer = setTimeout(() => {
      const literalEdited = scripts.literal !== context.script;
      const draft: ReadAloudDraft = {
        savedAt: Date.now(),
        mode,
        ...(literalEdited ? { literalBase: context.script, literal: scripts.literal } : {}),
        ...(scripts.adapted ? { adapted: scripts.adapted } : {}),
        ...(scripts.summary ? { summary: scripts.summary } : {}),
        written,
        maxMinutes,
        share,
        instructions,
        insertText,
      };
      const worthKeeping =
        literalEdited || !!scripts.adapted || !!scripts.summary || !!instructions.trim();
      saveDraft(plugin, context.remId, worthKeeping ? draft : undefined).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [restored, context, scripts, written, maxMinutes, share, instructions, insertText, mode]);

  // Summary length: a share of the note (its Literal script), capped by the maximum length.
  const literalWords = scriptWords(scripts.literal);
  const wpm = engines.find((e) => e.id === lastPlanned)?.wordsPerMinute ?? FALLBACK_WPM;
  const capMinutes = parseFloat(maxMinutes.replace(',', '.'));
  const capWords = capMinutes > 0 ? Math.round(capMinutes * wpm) : Infinity;
  const shareWords = Math.round((literalWords * share) / 100);
  const targetWords = Math.max(20, Math.min(shareWords, capWords));
  const capped = capWords < shareWords;

  // The helper's estimate, refreshed as the script or engine changes.
  useEffect(() => {
    if (!script.trim()) {
      setPlan(null);
      return;
    }
    const timer = setTimeout(() => {
      planTts(script, engine, voice || null)
        .then((p) => {
          setPlan(p);
          if (p.engines?.length) setEngines(p.engines);
          if (p.engine) setLastPlanned(p.engine);
        })
        .catch((err) => setPlan({ ok: false, errors: [String(err)] }));
    }, PLAN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [script, engine, voice]);

  const close = () => plugin.widget.closePopup();

  // Adapted / Summary: the helper's LLM step writes the script from the outline.
  const writeScript = async () => {
    if (!context || mode === 'literal') return;
    const target = mode;
    const mine = ++run.current;
    setPhase({ kind: 'writing', stage: 'starting', elapsed: 0 });
    try {
      const taskId = await startWrite(
        context,
        target,
        target === 'summary' ? targetWords : null,
        target === 'summary' ? instructions : ''
      );
      for (;;) {
        await sleep(POLL_MS);
        if (mine !== run.current) return;
        const task = await getTtsTask<WriteResult>(taskId);
        if (mine !== run.current) return;
        if (task.status === 'done') {
          const result = task.result;
          if (!result?.ok) {
            setPhase({ kind: 'error', message: result?.message ?? 'the AI step failed' });
            return;
          }
          setScripts((all) => ({ ...all, [target]: result.script ?? '' }));
          setWritten((all) => ({
            ...all,
            [target]: { ...result, writtenAt: Date.now(), sourceHash: sourceHash(context.source) },
          }));
          setPhase({ kind: 'editing' });
          return;
        }
        setPhase({ kind: 'writing', stage: task.stage, elapsed: task.elapsed });
      }
    } catch (err) {
      if (mine === run.current) setPhase({ kind: 'error', message: String(err) });
    }
  };

  // The helper starts synthesising; the wait and the insert run in the tracker
  // (lib/read_aloud.ts, runReadAloudJob), which reports with a message dialog. The
  // popup only stays up long enough to show a failure to start.
  const generate = async () => {
    if (!context || !plan?.ok || !plan.ready || !plan.engine) return;
    const mine = ++run.current;
    setPhase({ kind: 'starting' });
    try {
      // The engine the estimate was made for (the suggestion, when left on automatic).
      const taskId = await startTts(
        script,
        plan.engine,
        voice || null,
        context.remId,
        context.title
      );
      const withText = mode === 'summary' && insertText;
      await enqueueReadAloudJob(plugin, {
        id: `${taskId}-${Date.now()}`,
        taskId,
        target: { remId: context.remId, title: context.title, lang: context.lang },
        mode,
        ...(withText ? { summaryText: script, summaryModel: written.summary?.model } : {}),
        queuedAt: Date.now(),
      });
      if (mine !== run.current) return;
      await plugin.app.toast(
        `🔊 Making the audio in the background (about ${minutes(plan.estSeconds ?? 0)} of speech) — ` +
          'a message will say when it is in.'
      );
      close();
    } catch (err) {
      if (mine === run.current) setPhase({ kind: 'error', message: String(err) });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) {
      e.preventDefault();
      if (mode !== 'literal' && !script.trim()) void writeScript();
      else void generate();
    }
  };

  const busy = phase.kind === 'starting' || phase.kind === 'writing';
  const stats = context?.stats;
  const skipped = Object.entries(stats?.skipped ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${SKIP_LABELS[k] ?? k}${n === 1 ? '' : 's'}`);
  const voices = plan?.ok ? (plan.voices ?? []) : [];
  const planned = engines.find((e) => e.id === plan?.engine);
  const canGenerate = !busy && !!plan?.ok && !!plan.ready;

  return (
    <div
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4"
      style={{
        outline: 'none',
        color: 'var(--rn-clr-content-primary)',
        height: '100vh',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <div style={{ flexShrink: 0 }}>
        <div className="text-base font-semibold">Read aloud</div>
        <div className="text-xs" style={muted}>
          {context?.title || 'Untitled rem'}
          {stats ? ` — ${stats.rems} rem${stats.rems === 1 ? '' : 's'} read` : ''}
          {skipped.length ? `; skipped ${skipped.join(', ')}` : ''}
          {stats?.truncated ? ' (stopped at 3000 rems)' : ''}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2" style={{ flexShrink: 0 }}>
        {MODES.map(([id, label]) => (
          <button
            key={id}
            onClick={() => {
              setMode(id);
              if (phase.kind === 'error') setPhase({ kind: 'editing' });
            }}
            disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            className="py-1 px-3 text-sm rounded"
            style={{
              border: '1px solid var(--rn-clr-border-primary)',
              background: mode === id ? '#3B82F6' : 'var(--rn-clr-background-primary)',
              color: mode === id ? 'white' : 'var(--rn-clr-content-primary)',
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {label}
          </button>
        ))}
        <span className="text-xs" style={muted}>
          {MODES.find(([id]) => id === mode)?.[2]}
        </span>
      </div>

      {mode === 'summary' && (
        <div className="flex flex-col gap-2 text-xs" style={{ flexShrink: 0 }}>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2">
              Length
              <input
                type="range"
                min={20}
                max={80}
                step={5}
                value={share}
                onChange={(e) => setShare(Number(e.target.value))}
                disabled={busy}
                style={{ width: 140 }}
              />
              {share}% of the note
            </label>
            <label className="flex items-center gap-1">
              at most
              <input
                type="number"
                min={1}
                max={60}
                value={maxMinutes}
                onChange={(e) => setMaxMinutes(e.target.value)}
                disabled={busy}
                className="rounded px-1 py-0.5"
                style={{ ...fieldStyle, width: '4em' }}
              />
              min
            </label>
            <span style={muted}>
              ≈ {targetWords} words · about {minutes((targetWords / wpm) * 60)}
              {capped ? ` (capped: ${share}% would be ${shareWords} words)` : ''}
            </span>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={insertText}
                onChange={(e) => setInsertText(e.target.checked)}
                disabled={busy}
              />
              Also insert the summary text under the audio
            </label>
          </div>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="Additional instructions (optional), e.g. focus on the definitions; end with three questions to answer"
            className="rounded px-2 py-1"
            style={{ ...fieldStyle, resize: 'none' }}
          />
        </div>
      )}

      {mode !== 'literal' && (
        <div className="flex items-center gap-2 text-xs" style={{ flexShrink: 0 }}>
          <Button
            label={script.trim() ? 'Rewrite with AI' : 'Write the script with AI'}
            onClick={() => void writeScript()}
            disabled={busy || !context}
            title={script.trim() ? 'Replaces the script below' : '⌘↵'}
          />
          <span style={muted}>
            {writtenInfo(written[mode], context ? sourceHash(context.source) : undefined)}
          </span>
        </div>
      )}

      <div className="text-xs" style={{ ...muted, flexShrink: 0 }}>
        The script below is what will be spoken. Edit it freely: <code>[pt]</code> starts a
        Portuguese line, <code>&lt;en&gt;term&lt;/en&gt;</code> /{' '}
        <code>&lt;pt&gt;termo&lt;/pt&gt;</code> mark a foreign term, <code>[pause]</code> on its own
        line leaves time to answer.
      </div>

      <textarea
        value={script}
        onChange={(e) => setScript(e.target.value)}
        disabled={busy}
        spellCheck={false}
        placeholder={
          mode === 'literal' ? '' : 'Press “Write the script with AI” (⌘↵) to fill this in.'
        }
        className="text-sm rounded px-2 py-1"
        style={{
          ...fieldStyle,
          flex: 1,
          minHeight: 0,
          resize: 'none',
          fontFamily: 'ui-monospace, monospace',
        }}
      />

      <div className="flex flex-wrap items-center gap-3 text-xs" style={{ flexShrink: 0 }}>
        <label className="flex items-center gap-1">
          Engine
          <select
            value={engine === 'auto' ? lastPlanned : engine}
            onChange={(e) => {
              setEngine(e.target.value);
              setVoice('');
            }}
            disabled={busy || !engines.length}
            className="rounded px-1 py-0.5"
            style={fieldStyle}
          >
            {!engines.some((e) => e.id === lastPlanned) && engine === 'auto' && (
              <option value="auto">Automatic</option>
            )}
            {engines.map((e) => (
              <option
                key={e.id}
                value={e.id}
                disabled={!e.available}
                title={
                  e.available ? e.note : `missing ${e.missing.join(', ')} in the helper's .env`
                }
              >
                {e.label}
                {e.id === plan?.suggested ? ' (suggested)' : ''}
                {e.available ? '' : ' — no key'}
              </option>
            ))}
          </select>
        </label>
        {voices.length > 1 && (
          <label className="flex items-center gap-1">
            Voice
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              disabled={busy}
              className="rounded px-1 py-0.5"
              style={fieldStyle}
            >
              <option value="">Random</option>
              {voices.map((v) => (
                <option key={v} value={v}>
                  {voiceLabel(v)}
                </option>
              ))}
            </select>
          </label>
        )}
        {plan?.ok && (
          <span style={muted}>
            {voices.length === 1 ? `${voiceLabel(voices[0])} · ` : ''}
            {plan.words} words · about {minutes(plan.estSeconds ?? 0)} · ~US$
            {(plan.estCostUsd ?? 0).toFixed(2)}
            {mode !== 'summary' && (plan.estSeconds ?? 0) > 12 * 60
              ? ' · long: consider a summary'
              : ''}
          </span>
        )}
      </div>

      {plan?.ok && (plan.note || !plan.ready) && (
        <div className="text-xs" style={{ ...muted, flexShrink: 0 }}>
          {plan.ready
            ? `${planned?.label ?? plan.engine}: ${plan.note}.`
            : `${planned?.label ?? plan.engine} has no key: add ${(plan.missing ?? []).join(', ')} to the helper's .env.`}
          {plan.ready && plan.engine !== plan.suggested && plan.suggested
            ? ` The suggestion was ${engines.find((e) => e.id === plan.suggested)?.label ?? plan.suggested}.`
            : ''}
        </div>
      )}

      {plan && !plan.ok && (
        <div
          className="rounded px-3 py-2 text-xs"
          style={{
            flexShrink: 0,
            maxHeight: 120,
            overflowY: 'auto',
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.5)',
          }}
        >
          {(plan.errors ?? []).map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}

      {phase.kind === 'error' && (
        <div
          className="rounded px-3 py-2 text-sm"
          style={{
            flexShrink: 0,
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.5)',
          }}
        >
          {phase.message}
        </div>
      )}

      <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
        <span className="text-sm" style={{ ...muted, flex: 1 }}>
          {phase.kind === 'writing' &&
            `${phase.stage[0]?.toUpperCase()}${phase.stage.slice(1)}… ${phase.elapsed} s — keep this window open`}
          {phase.kind === 'starting' && 'Handing the script to the helper…'}
        </span>
        <Button label={busy ? 'Stop waiting' : 'Cancel'} onClick={close} />
        <Button
          label={phase.kind === 'error' ? 'Try again' : 'Generate'}
          primary
          disabled={!canGenerate}
          title="⌘↵ — runs in the background; a message says when the audio is in"
          onClick={() => void generate()}
        />
      </div>
    </div>
  );
}

renderWidget(ReadAloudPopup);
