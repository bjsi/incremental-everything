import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import { MessageDialog } from '../lib/message_dialog';
import { PinQuoteRequest, pinQuoteInViews, SourceView } from '../lib/pdf_source_pins';
import { MessageBody } from '../components/MessageBody';

const CHOICE_KEY = 'pin-source-views-choice';

const CHOICES: { views: SourceView[]; label: string; hint: string }[] = [
  { views: ['pdf', 'html'], label: 'Both views', hint: 'A highlight in the PDF and one in the Text Reader, both pinned' },
  { views: ['pdf'], label: 'PDF only', hint: 'Pin the passage in the PDF view' },
  { views: ['html'], label: 'Text Reader only', hint: 'Pin the passage in the Text Reader view' },
];

/** The Enter that ran the command from the Omnibar can reach the popup; ignore Enter this soon after opening. */
const ENTER_GRACE_MS = 300;

/**
 * Asked by Pin Source Quote when the PDF also has a Text Reader version. The
 * plugin cannot tell which of the two views is on screen (RemNote sets its
 * "open in Text Reader" flag and never clears it), so the choice is explicit,
 * remembered per device, and Esc cancels without pinning anything.
 *
 * A failure is shown here rather than in a second popup: opening one would
 * replace this popup, and closing this one would then close the message too.
 */
export function PinSourceViewsPopup() {
  const plugin = usePlugin();
  const [request, setRequest] = useState<PinQuoteRequest | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<MessageDialog | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      setRequest((ctx?.contextData?.request as PinQuoteRequest) ?? null);
      const saved = await plugin.storage.getLocal<number>(CHOICE_KEY);
      if (typeof saved === 'number' && saved >= 0 && saved < CHOICES.length) setSelected(saved);
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

  const close = () => plugin.widget.closePopup();

  const choose = async (index: number) => {
    if (!request || busy) return;
    setBusy(true);
    setSelected(index);
    await plugin.storage.setLocal(CHOICE_KEY, index);
    const outcome = await pinQuoteInViews(plugin as any, request, CHOICES[index].views);
    if (outcome.ok) {
      close();
      return;
    }
    setFailure(outcome.dialog);
    setBusy(false);
    containerRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON' || busy) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (failure) {
      if (e.key === 'Enter') {
        e.preventDefault();
        close();
      }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      setSelected((s) => (s + 1) % CHOICES.length);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setSelected((s) => (s + CHOICES.length - 1) % CHOICES.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (Date.now() - openedAt.current >= ENTER_GRACE_MS) choose(selected);
    }
  };

  const ring: React.CSSProperties = { outline: '2px solid var(--rn-clr-border-accent, #3B82F6)', outlineOffset: '2px' };
  const quote = request?.quote ?? '';
  const excerpt = quote.length > 160 ? `${quote.slice(0, 160)}…` : quote;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4"
      style={{ outline: 'none', color: 'var(--rn-clr-content-primary)' }}
    >
      {failure ? (
        <>
          <MessageBody dialog={failure} />
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              Enter or Esc to close
            </span>
            <button
              onClick={close}
              onMouseDown={(e) => e.preventDefault()}
              className="py-1.5 px-4 text-sm font-medium rounded"
              style={{ background: '#3B82F6', color: 'white', border: 'none', cursor: 'pointer', ...ring }}
            >
              OK
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 18 }}>📌</span>
            <span className="font-semibold text-base">Pin Source Quote</span>
          </div>

          <div className="text-sm">This PDF also has a Text Reader version. Where should the passage be pinned?</div>
          {excerpt && (
            <div
              className="text-xs italic p-2 rounded"
              style={{ background: 'var(--rn-clr-background-elevation-10)', color: 'var(--rn-clr-content-secondary)' }}
            >
              {excerpt}
            </div>
          )}

          <div className="flex flex-col gap-2">
            {CHOICES.map((choice, index) => (
              <button
                key={choice.label}
                onClick={() => choose(index)}
                onMouseEnter={() => !busy && setSelected(index)}
                onMouseDown={(e) => e.preventDefault()}
                disabled={busy || !request}
                className="w-full py-2 px-3 text-sm font-medium rounded text-left"
                style={{
                  ...(index === 0
                    ? { background: '#3B82F6', color: 'white', border: 'none' }
                    : {
                        background: 'transparent',
                        color: 'var(--rn-clr-content-primary)',
                        border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))',
                      }),
                  cursor: busy ? 'progress' : 'pointer',
                  ...(selected === index ? ring : {}),
                }}
              >
                <div>{choice.label}</div>
                <div className="text-xs font-normal mt-0.5" style={{ opacity: 0.85 }}>
                  {busy && selected === index ? 'Pinning…' : choice.hint}
                </div>
              </button>
            ))}
          </div>

          <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            ↑↓ choose · Enter confirm · Esc cancel
          </div>
        </>
      )}
    </div>
  );
}

renderWidget(PinSourceViewsPopup);
