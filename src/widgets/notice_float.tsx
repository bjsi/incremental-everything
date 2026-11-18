import { renderWidget, usePlugin, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import { MessageBody } from '../components/MessageBody';
import { noticesKey } from '../lib/consts';
import { FloatingPosition, useFloatingWidgetDrag } from '../lib/floating_widget_drag';
import { answerNotice, dismissNotices, Notice, NOTICE_POSITION } from '../lib/notice';

const button = (primary: boolean): React.CSSProperties => ({
  background: primary ? '#3B82F6' : 'var(--rn-clr-background-secondary)',
  color: primary ? 'white' : 'var(--rn-clr-content-primary)',
  border: 'none',
  cursor: 'pointer',
});

const edge = { error: '#EF4444', success: '#10B981', info: '#3B82F6' };

/**
 * The notices of background work (lib/notice.ts), newest first, in a floating card the
 * index opens and closes. It never takes focus: it arrives while the user is typing
 * elsewhere, often in a popup. Esc, once the card has been clicked, dismisses them all.
 * Dragging anywhere but a button moves it; it still opens at the same spot every time.
 * A question (`notice.ask`, from `media_bridge.py ask`) shows its choices in place of
 * Dismiss; the chosen one goes back to the tool that asked.
 */
function NoticeFloat() {
  const plugin = usePlugin();
  const notices = useTrackerPlugin(
    async (rp) => (await rp.storage.getSession<Notice[]>(noticesKey)) || [],
    []
  );
  const list = [...(notices ?? [])].reverse();

  // The card's host position, in the edges the index opened it with, so the drag can
  // shift them (lib/floating_widget_drag.ts). The drag waits for the widget id.
  const [floatingWidgetId, setFloatingWidgetId] = useState<string | null>(null);
  const positionRef = useRef<FloatingPosition | null>(NOTICE_POSITION);
  useEffect(() => {
    plugin.widget
      .getWidgetContext<WidgetLocation.FloatingWidget>()
      .then((ctx) => setFloatingWidgetId(ctx?.floatingWidgetId ?? null))
      .catch((e) => console.warn('[Notice] no drag: widget context unavailable', e));
  }, [plugin]);
  const startDrag = useFloatingWidgetDrag(plugin, floatingWidgetId, positionRef);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // A press on the list's own scrollbar scrolls it.
    const el = e.currentTarget;
    if (e.target === el && e.nativeEvent.offsetX >= el.clientWidth) return;
    startDrag(e);
  };

  const openRem = async (notice: Notice) => {
    const rem = notice.openRemId ? await plugin.rem.findOne(notice.openRemId) : undefined;
    if (rem) await plugin.window.openRem(rem);
    else await plugin.app.toast('That Rem no longer exists.');
    // A question stays up: the Rem is opened to decide it.
    if (!notice.ask) await dismissNotices(plugin, notice.id);
  };

  const answer = async (notice: Notice, choice: string) => {
    if (!(await answerNotice(plugin, notice, choice)))
      await plugin.app.toast('Could not send the answer: is the Local Media Bridge running?');
  };

  const runAction = async (notice: Notice) => {
    if (notice.action) await plugin.widget.openPopup(notice.action.popup, notice.action.data);
  };

  if (!list.length) return null;
  return (
    <div
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          void dismissNotices(plugin);
        }
      }}
      className="flex flex-col gap-2"
      style={{ width: 380, maxHeight: 520, overflowY: 'auto', outline: 'none', padding: 4 }}
    >
      <div
        className="flex items-center justify-between text-xs px-1"
        style={{ cursor: 'grab', minHeight: 22 }}
      >
        <span style={{ color: 'var(--rn-clr-content-secondary)' }} data-tip="Drag to move">
          ⠿ {list.length} {list.length > 1 ? 'notices' : 'notice'}
        </span>
        {list.length > 1 && (
          <button
            onClick={() => void dismissNotices(plugin)}
            className="py-0.5 px-2 rounded"
            style={button(false)}
          >
            Dismiss all
          </button>
        )}
      </div>
      {list.map((notice) => (
        <div
          key={notice.id}
          className="flex flex-col gap-2 p-3 rounded"
          style={{
            background: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-primary)',
            border: '1px solid var(--rn-clr-border-primary)',
            borderLeft: `4px solid ${edge[notice.tone ?? 'info']}`,
            boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
          }}
        >
          <MessageBody dialog={notice} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              {new Date(notice.at).toLocaleTimeString(undefined, { timeStyle: 'short' })}
            </span>
            <div className="flex items-center gap-2">
              {notice.action && (
                <button
                  onClick={() => void runAction(notice)}
                  className="py-1 px-3 text-sm font-medium rounded"
                  style={button(true)}
                >
                  {notice.action.label}
                </button>
              )}
              {notice.openRemId && (
                <button
                  onClick={() => void openRem(notice)}
                  className="py-1 px-3 text-sm font-medium rounded"
                  style={button(!notice.action && !notice.ask)}
                >
                  Open Rem
                </button>
              )}
              {notice.ask ? (
                notice.ask.choices.map((choice, k) => (
                  <button
                    key={choice}
                    onClick={() => void answer(notice, choice)}
                    className="py-1 px-3 text-sm font-medium rounded"
                    style={button(k === 0)}
                  >
                    {choice}
                  </button>
                ))
              ) : (
                <button
                  onClick={() => void dismissNotices(plugin, notice.id)}
                  className="py-1 px-3 text-sm font-medium rounded"
                  style={button(!notice.openRemId && !notice.action)}
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

renderWidget(withHoverTips(NoticeFloat));
