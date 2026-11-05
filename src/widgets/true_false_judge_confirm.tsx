import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import {
  JudgeConfirmAnswer,
  JudgeConfirmContext,
  judgeConfirmRequestKey,
  splitOnVerdictWords,
  VERDICT_MARK,
} from '../lib/true_false';

/** The Enter that ran the command from the Omnibar can reach the popup; ignore Enter this soon after opening. */
const ENTER_GRACE_MS = 300;

const LABEL_STYLE: React.CSSProperties = { color: 'var(--rn-clr-content-tertiary)', lineHeight: '20px' };
const VALUE_STYLE: React.CSSProperties = {
  color: 'var(--rn-clr-content-primary)',
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
};

/**
 * "True/False: Judge by Emoji" asking first: the counts, and a checklist of the
 * cards judged by a word. The answer goes back to src/register/true_false.ts, which
 * marks them.
 */
export function TrueFalseJudgeConfirm() {
  const plugin = usePlugin();
  const [context, setContext] = useState<JudgeConfirmContext | null>(null);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  // One cursor over the cards, then the buttons.
  const [cursor, setCursor] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLElement | null>(null);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      setContext((ctx?.contextData as JudgeConfirmContext) ?? null);
    })();
  }, []);

  // Keys are read on the container, which has to win focus against RemNote
  // settling it after the popup opens.
  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      containerRef.current?.focus();
      if (document.activeElement === containerRef.current || ++tries >= 8) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    cursorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const byWord = context?.byWord ?? [];
  const accepted = byWord.filter((item) => !rejected.has(item.remId));
  const trueCount = (context?.trueByMark ?? 0) + accepted.filter((item) => item.verdict === 'true').length;
  const falseCount = (context?.falseByMark ?? 0) + accepted.filter((item) => item.verdict === 'false').length;
  const toMark = trueCount + falseCount;

  const close = () => plugin.widget.closePopup();

  const confirm = async () => {
    if (!context || toMark === 0) return;
    const answer: JudgeConfirmAnswer = { id: context.id, rejectedRemIds: Array.from(rejected) };
    await plugin.storage.setSession(judgeConfirmRequestKey, answer);
    close();
  };

  const toggle = (remId: string) =>
    setRejected((current) => {
      const next = new Set(current);
      if (!next.delete(remId)) next.add(remId);
      return next;
    });

  const buttons: { label: string; run: () => void; primary?: boolean }[] = [
    { label: `Mark ${toMark}`, run: confirm, primary: true },
    { label: 'Cancel', run: close },
  ];
  const stops = byWord.length + buttons.length;
  const markStop = byWord.length;
  const cancelStop = byWord.length + 1;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (Date.now() - openedAt.current < ENTER_GRACE_MS) return;
      if (cursor === cancelStop) close();
      else confirm();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (cursor < byWord.length) toggle(byWord[cursor].remId);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((i) => (i + 1) % stops);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((i) => (i - 1 + stops) % stops);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setCursor((i) => (i === markStop ? cancelStop : markStop));
    }
  };

  const notes = context
    ? [
        context.alreadyMarked > 0 && `${context.alreadyMarked} already marked`,
        context.bothMarks > 0 && `${context.bothMarks} saying both true and false, left alone`,
        context.scanned > 1 && `${context.scanned} Rems checked`,
      ].filter(Boolean)
    : [];

  const ring = (active: boolean) => (active ? '2px solid var(--rn-clr-border-accent, #3B82F6)' : 'none');

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4"
      style={{ outline: 'none', color: 'var(--rn-clr-content-primary)' }}
    >
      <div className="text-base font-semibold">Judge these cards?</div>
      {context && (
        <>
          <div className="flex flex-col gap-1 text-sm font-medium">
            <div>
              {toMark + rejected.size}{' '}
              {toMark + rejected.size === 1 ? 'candidate' : 'candidates'} found
              {rejected.size > 0 ? `, ${rejected.size} unticked` : ''}:
            </div>
            <div>{VERDICT_MARK.true} {trueCount} would be marked true</div>
            <div>{VERDICT_MARK.false} {falseCount} would be marked false</div>
          </div>
          {byWord.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-xs font-semibold" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                Judged by a word, not a mark ({byWord.length}): untick the wrong ones
              </div>
              <div
                className="flex flex-col gap-1 overflow-y-auto"
                style={{ maxHeight: 340, padding: 3 }}
              >
                {byWord.map((item, i) => (
                  <div
                    key={item.remId}
                    ref={(el) => {
                      if (cursor === i) cursorRef.current = el;
                    }}
                    onClick={() => {
                      setCursor(i);
                      toggle(item.remId);
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    className="flex items-start gap-2 p-2 rounded"
                    style={{
                      cursor: 'pointer',
                      background: 'var(--rn-clr-background-secondary)',
                      outline: ring(cursor === i),
                      opacity: rejected.has(item.remId) ? 0.55 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!rejected.has(item.remId)}
                      readOnly
                      tabIndex={-1}
                      style={{ marginTop: 3, pointerEvents: 'none' }}
                    />
                    <span>{VERDICT_MARK[item.verdict]}</span>
                    <div
                      className="min-w-0 text-sm"
                      style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 8, rowGap: 4 }}
                    >
                      <div className="text-xs" style={LABEL_STYLE}>Front</div>
                      <div style={VALUE_STYLE}>{item.remText}</div>
                      <div className="text-xs" style={LABEL_STYLE}>Back</div>
                      <div style={VALUE_STYLE}>
                        {splitOnVerdictWords(item.backText).map((part, j) =>
                          part.isWord ? <strong key={j}>{part.text}</strong> : <span key={j}>{part.text}</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {notes.length > 0 && (
            <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              {notes.join(' · ')}
            </div>
          )}
        </>
      )}
      <div className="flex items-center justify-end gap-2">
        {buttons.map((button, i) => {
          const stop = byWord.length + i;
          const disabled = button.primary && toMark === 0;
          return (
            <button
              key={i}
              ref={(el) => {
                if (cursor === stop) cursorRef.current = el;
              }}
              onClick={button.run}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setCursor(stop)}
              disabled={disabled}
              className="py-1.5 px-3 text-sm font-medium rounded"
              style={{
                background: button.primary ? '#3B82F6' : 'var(--rn-clr-background-secondary)',
                color: button.primary ? 'white' : 'var(--rn-clr-content-primary)',
                border: 'none',
                cursor: disabled ? 'default' : 'pointer',
                opacity: disabled ? 0.5 : 1,
                outline: ring(cursor === stop),
                outlineOffset: '2px',
              }}
            >
              {button.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

renderWidget(withHoverTips(TrueFalseJudgeConfirm));
