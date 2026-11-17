import {
  AppEvents,
  renderWidget,
  useAPIEventListener,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import {
  currentSubQueueIdKey,
  incRemDisabledDeviceKey,
  menuHubActiveIdKey,
  menuHubAnchorPosition,
  menuHubTargetKey,
  noIncRemTimerKey,
  powerupCode,
} from '../lib/consts';
import { FloatingPosition, useFloatingWidgetDrag } from '../lib/floating_widget_drag';
import { resolveRemTextAsTitle } from '../lib/richTextRemRefs';
import { showMessageDialog } from '../lib/message_dialog';
import {
  MenuHubTarget,
  openAudioPlaylist,
  openBatchCardPriority,
  openBatchPriority,
  openCardEnablementAudit,
  openDocumentStudyDashboard,
  openPdfControlPanel,
  openPriorityQueue,
  openPriorityShieldHistory,
  openQueuePriorityQueue,
  openQueueStudyDashboard,
  openQueueShieldHistory,
  openSetPriority,
  openSortingCriteria,
  openTaggedAudioPlaylist,
  pauseIncRemsFor15Min,
  toggleIncrementalRem,
  toggleIncRemsOnThisDevice,
} from '../lib/menu_hub_actions';

/**
 * The Menu Hub: the plugin's Document menu and Queue menu actions in one
 * floating panel.
 *
 * RemNote draws plugin menu items as a flat list and has no way to nest them,
 * so each of those menus has a single "Incremental RemNote…" item, which opens
 * this just below the menu's button (see openMenuHub). It closes once an
 * action has run, and with ✕ or Esc (with the panel focused). Until then it
 * stays open beside the editor or the queue (no close on an outside click) and
 * follows the user: in the queue it lists the queue actions, elsewhere the
 * document actions for the focused pane's document. Drag it by the header.
 */

type Plugin = ReturnType<typeof usePlugin>;

type HubAction = {
  id: string;
  label: string;
  group: string;
  run: (plugin: Plugin, remId: string | undefined) => Promise<void>;
  /** Acts on the target Rem, so it is off while there is none. */
  needsRem?: boolean;
};

const doc =
  (fn: (plugin: Plugin, remId: string) => Promise<void>) =>
  (plugin: Plugin, remId: string | undefined) =>
    remId ? fn(plugin, remId) : Promise.resolve();

const DOCUMENT_ACTIONS: HubAction[] = [
  { id: 'toggle', label: 'Toggle Incremental Rem', group: 'Incremental Rem', run: doc(toggleIncrementalRem), needsRem: true },
  // Priorities apply to Incremental Rems and flashcards alike.
  { id: 'priority', label: 'Set Priority', group: 'Priority', run: doc(openSetPriority), needsRem: true },
  { id: 'batch', label: 'Batch Priority Change', group: 'Priority', run: doc(openBatchPriority), needsRem: true },
  {
    id: 'card-priority',
    label: 'Batch Card Priority (tagged / referencing)',
    group: 'Priority',
    run: doc(openBatchCardPriority),
    needsRem: true,
  },
  { id: 'queue', label: 'Priority Queue', group: 'Queue', run: doc(openPriorityQueue), needsRem: true },
  { id: 'pdf', label: 'PDF Control Panel', group: 'PDF', run: doc(openPdfControlPanel), needsRem: true },
  { id: 'shield', label: 'Priority Shield History', group: 'Statistics', run: doc(openPriorityShieldHistory), needsRem: true },
  { id: 'dashboard', label: 'Study Dashboard', group: 'Statistics', run: doc(openDocumentStudyDashboard), needsRem: true },
  { id: 'audit', label: 'Audit Card Enablement', group: 'Flashcards', run: doc(openCardEnablementAudit), needsRem: true },
  { id: 'audio', label: 'Audio Playlist (this document)', group: 'Audio', run: doc(openAudioPlaylist), needsRem: true },
  { id: 'audio-tag', label: 'Audio Playlist (rems tagged with this)', group: 'Audio', run: doc(openTaggedAudioPlaylist), needsRem: true },
];

const QUEUE_ACTIONS: HubAction[] = [
  { id: 'q-priority-queue', label: 'Priority Queue', group: 'This queue', run: openQueuePriorityQueue },
  { id: 'q-sorting', label: 'Sorting Criteria', group: 'This queue', run: openSortingCriteria },
  { id: 'q-shield', label: 'Priority Shield History', group: 'Statistics', run: openQueueShieldHistory },
  { id: 'q-dashboard', label: 'Study Dashboard', group: 'Statistics', run: openQueueStudyDashboard },
  { id: 'q-pause', label: 'No Inc Rems for 15 min', group: 'Incremental Rems', run: pauseIncRemsFor15Min },
  { id: 'q-device', label: 'Toggle Inc Rems on this device', group: 'Incremental Rems', run: toggleIncRemsOnThisDevice },
];

const ring: React.CSSProperties = {
  outline: '2px solid var(--rn-clr-border-accent, #3B82F6)',
  outlineOffset: '-2px',
};

/** Rem references show their text, as in breadcrumbs; pins (📌) are left out. */
async function remName(plugin: Plugin, remId: string): Promise<string | null> {
  const rem = await plugin.rem.findOne(remId);
  return rem ? resolveRemTextAsTitle(plugin, rem.text) : null;
}

function MenuHub() {
  const plugin = usePlugin();
  const containerRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<FloatingPosition | null>(null);
  const [widgetId, setWidgetId] = useState<string | null>(null);
  const [instanceId, setInstanceId] = useState<number | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>();
      // A number on the bridge, typed as a string by getWidgetContext.
      const inst = Number(ctx?.widgetInstanceId);
      setInstanceId(Number.isFinite(inst) ? inst : null);
      setWidgetId(ctx?.floatingWidgetId ?? null);
    })().catch((e) => console.error('[MenuHub] init error', e));
  }, [plugin]);

  const target = useTrackerPlugin((rp) => rp.storage.getSession<MenuHubTarget>(menuHubTargetKey), []);
  const mode = target?.mode ?? 'document';
  const remId = target?.remId;
  const actions = mode === 'queue' ? QUEUE_ACTIONS : DOCUMENT_ACTIONS;

  useEffect(() => setSelected(0), [mode]);

  const docName = useTrackerPlugin(
    async (rp) => (mode === 'document' && remId ? remName(rp, remId) : null),
    [mode, remId]
  );
  const isIncremental = useTrackerPlugin(
    async (rp) => {
      if (mode !== 'document' || !remId) return false;
      const rem = await rp.rem.findOne(remId);
      return !!rem && (await rem.hasPowerup(powerupCode));
    },
    [mode, remId]
  );
  const queueScope = useTrackerPlugin(
    async (rp) => {
      if (mode !== 'queue') return null;
      const scopeId = await rp.storage.getSession<string | null>(currentSubQueueIdKey);
      return scopeId ? (await remName(rp, scopeId)) ?? 'Queue' : 'All flashcards';
    },
    [mode]
  );
  const disabledOnDevice = useTrackerPlugin(
    (rp) => rp.storage.getLocal<boolean>(incRemDisabledDeviceKey),
    []
  );
  const pausedUntil = useTrackerPlugin((rp) => rp.storage.getSynced<number>(noIncRemTimerKey), []);

  // Follow the user: in the queue, the queue actions; elsewhere, the document
  // actions for the focused pane's document, as its "…" menu would. A pane
  // with no Rem (a plugin page) keeps the last target.
  const follow = useCallback(async () => {
    try {
      const current = await plugin.storage.getSession<MenuHubTarget>(menuHubTargetKey);
      const url = await plugin.window.getURL().catch(() => '');
      if (typeof url === 'string' && url.includes('/flashcards')) {
        if (current?.mode === 'queue') return;
        await plugin.storage.setSession(menuHubTargetKey, {
          mode: 'queue',
          remId: current?.remId,
          at: Date.now(),
          source: 'pane',
        } satisfies MenuHubTarget);
        return;
      }
      const paneRemId = await plugin.window.getOpenPaneRemId(await plugin.window.getFocusedPaneId());
      if (!paneRemId) return;
      if (current?.mode === 'document' && current.remId === paneRemId) return;
      await plugin.storage.setSession(menuHubTargetKey, {
        mode: 'document',
        remId: paneRemId,
        at: Date.now(),
        source: 'pane',
      } satisfies MenuHubTarget);
    } catch (e) {
      console.error('[MenuHub] follow error', e);
    }
  }, [plugin]);
  useAPIEventListener(AppEvents.URLChange, undefined, follow);
  useAPIEventListener(AppEvents.FocusedPaneChange, undefined, follow);
  useAPIEventListener(AppEvents.CurrentWindowTreeChange, undefined, follow);

  // Set when a menu item opened or re-pointed the hub; unchanged when the hub
  // only follows the user, so that neither moves it nor takes the keyboard.
  const menuTrigger = target && target.source !== 'pane' ? target.at : 0;

  // Opened (or re-pointed) from a menu, the hub sits at the marker position,
  // where host CSS anchors it under the menu's button. Read where that put it
  // and move there for real: the CSS lets go once the inline style changes, and
  // the drag needs plain coordinates. The wrapper's containing block is the
  // viewport, so the iframe's rect is its position (as in reference_finder).
  useEffect(() => {
    if (!widgetId || instanceId == null) return;
    let cancelled = false;
    (async () => {
      // Let the host apply the marker position and lay the anchor out.
      await new Promise((r) => setTimeout(r, 80));
      if (cancelled) return;
      const rect = await plugin.widget.getDimensions(instanceId);
      if (cancelled || !rect || rect.width === 0) return;
      const placed = { top: Math.round(rect.top), left: Math.round(rect.left) };
      if (placed.top === menuHubAnchorPosition.top && placed.left === menuHubAnchorPosition.left) {
        positionRef.current = placed; // the anchor rule didn't apply; stay put
        return;
      }
      await plugin.window.setFloatingWidgetPosition(widgetId, placed);
      positionRef.current = placed;
    })().catch((e) => console.error('[MenuHub] placement error', e));
    return () => {
      cancelled = true;
    };
  }, [plugin, widgetId, instanceId, menuTrigger]);

  // Take the keyboard when a menu opens or re-points the hub (the user just
  // asked for it), not when it follows a pane, which would pull focus out of
  // the editor. The retry loop wins against RemNote settling focus after the
  // float mounts.
  useEffect(() => {
    let cancelled = false;
    const tryFocus = (attemptsLeft: number) => {
      if (cancelled) return;
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      containerRef.current?.focus();
      if (document.activeElement !== containerRef.current && attemptsLeft > 0) {
        setTimeout(() => tryFocus(attemptsLeft - 1), 50);
      }
    };
    tryFocus(8);
    return () => {
      cancelled = true;
    };
  }, [menuTrigger]);

  const close = useCallback(async () => {
    await plugin.storage.setSession(menuHubActiveIdKey, undefined);
    if (widgetId) await plugin.window.closeFloatingWidget(widgetId);
  }, [plugin, widgetId]);

  const isEnabled = (action: HubAction) => !action.needsRem || !!remId;

  const run = useCallback(
    async (index: number) => {
      const action = actions[index];
      if (!action || !isEnabled(action) || busy) return;
      setSelected(index);
      setBusy(action.id);
      try {
        await action.run(plugin, remId);
      } catch (e) {
        console.error(`[MenuHub] ${action.id} failed`, e);
        await showMessageDialog(plugin, {
          title: `${action.label} failed`,
          message: e instanceof Error ? e.message : String(e),
          tone: 'error',
        });
      } finally {
        setBusy(null);
      }
      // Close only after the action has finished: it runs in this iframe, and
      // closing the float tears the iframe down, which would cut off the rest
      // of its awaits (Toggle Incremental Rem writes, then opens a popup).
      await close();
    },
    [plugin, actions, remId, busy, close]
  );

  // Keys on the container, never on the buttons: a focused button would fire
  // its native Enter click and this handler both.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if ((e.target as HTMLElement)?.tagName === 'BUTTON') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSelected((i) => (i + step + actions.length) % actions.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      run(selected);
      return;
    }
    const digit = Number(e.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(9, actions.length)) {
      e.preventDefault();
      run(digit - 1);
    }
  };

  const onHeaderPointerDown = useFloatingWidgetDrag(plugin, widgetId, positionRef);

  const labelFor = (action: HubAction) => {
    switch (action.id) {
      case 'toggle':
        return isIncremental ? 'Remove Incremental Rem tag' : 'Make Incremental Rem';
      case 'q-device':
        return disabledOnDevice ? 'Enable Inc Rems on this device' : 'Disable Inc Rems on this device';
      case 'q-pause': {
        const left = pausedUntil ? Math.ceil((pausedUntil - Date.now()) / 60000) : 0;
        return left > 0 ? `No Inc Rems for 15 min (${left} min left)` : action.label;
      }
      default:
        return action.label;
    }
  };

  const subtitle =
    mode === 'queue'
      ? `🗂 ${queueScope ?? '…'}`
      : remId
        ? `📄 ${docName ?? '…'}`
        : 'Open a document to act on it';

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        outline: 'none',
        width: '100%',
        boxSizing: 'border-box',
        background: 'var(--rn-clr-background-primary)',
        color: 'var(--rn-clr-content-primary)',
        border: '1px solid var(--rn-clr-border-primary)',
        borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        fontSize: 13,
        overflow: 'hidden',
      }}
    >
      <div
        onPointerDown={onHeaderPointerDown}
        style={{
          cursor: 'move',
          userSelect: 'none',
          touchAction: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px 6px 12px',
          borderBottom: '1px solid var(--rn-clr-border-primary)',
          background: 'var(--rn-clr-background-secondary)',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>Incremental RemNote</div>
          <div
            title={subtitle}
            style={{
              fontSize: 11,
              color: 'var(--rn-clr-content-secondary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {subtitle}
          </div>
        </div>
        <button
          onClick={close}
          onMouseDown={(e) => e.preventDefault()}
          title="Close (Esc)"
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--rn-clr-content-secondary)',
            cursor: 'pointer',
            fontSize: 14,
            padding: '2px 6px',
            borderRadius: 4,
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ padding: '4px 0' }}>
        {actions.map((action, i) => {
          const showGroup = i === 0 || actions[i - 1].group !== action.group;
          const enabled = isEnabled(action);
          return (
            <React.Fragment key={action.id}>
              {showGroup && (
                <div
                  style={{
                    padding: '6px 12px 2px',
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: 0.4,
                    textTransform: 'uppercase',
                    color: 'var(--rn-clr-content-tertiary)',
                  }}
                >
                  {action.group}
                </div>
              )}
              <button
                onClick={() => run(i)}
                onMouseEnter={() => setSelected(i)}
                onMouseDown={(e) => e.preventDefault()}
                disabled={!enabled}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 12px',
                  border: 'none',
                  borderRadius: 0,
                  background: i === selected ? 'var(--rn-clr-background-tertiary)' : 'transparent',
                  color: enabled ? 'var(--rn-clr-content-primary)' : 'var(--rn-clr-content-tertiary)',
                  cursor: enabled ? 'pointer' : 'default',
                  fontSize: 13,
                  ...(i === selected ? ring : {}),
                }}
              >
                <span
                  style={{
                    width: 14,
                    fontSize: 11,
                    color: 'var(--rn-clr-content-tertiary)',
                    flexShrink: 0,
                  }}
                >
                  {i < 9 ? i + 1 : ''}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>{labelFor(action)}</span>
                {busy === action.id && <span style={{ fontSize: 11 }}>…</span>}
              </button>
            </React.Fragment>
          );
        })}
      </div>

      <div
        style={{
          padding: '6px 12px',
          fontSize: 11,
          color: 'var(--rn-clr-content-tertiary)',
          borderTop: '1px solid var(--rn-clr-border-primary)',
        }}
      >
        ↑↓ choose · Enter or 1–{Math.min(9, actions.length)} run · Esc close
      </div>
    </div>
  );
}

renderWidget(withHoverTips(MenuHub));
