import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import { IE_DOCS_BASE_URL } from '../lib/settings';
import { safeRemTextToString } from '../lib/pdfUtils';
import { onboardingTipsWidgetId, pluginHubHiddenKey } from '../lib/consts';
import {
  OnboardingTip,
  acknowledgeTip,
  ONBOARDING_TIPS,
  backfillLocalMirror,
  getAcknowledgedTipIds,
  getDrawnTipIdThisSession,
  getLastShownMap,
  markTipAnsweredThisSession,
  pickTip,
  recordTipShown,
  setDrawnTipIdThisSession,
  snoozeTips,
  tipAnsweredThisSession,
  tipsAreSnoozed,
} from '../lib/onboarding_tips';

/**
 * The "Incremental RemNote" sidebar hub.
 *
 * The plugin's surface is spread across a slash-command list, a settings popup,
 * two document menus and a dozen shortcuts, none of which announce themselves.
 * This panel is the one fixed place that does: five things a new user needs
 * within reach, and one tip per session from the onboarding pile.
 *
 * It sits in `SidebarEnd` next to the Mastery Drill notification, and is not
 * gated behind a setting — it is the entry point, so it has to be there before
 * the user knows there are settings to find.
 *
 * Everything here is sized for a *narrow* column. RemNote already pads the
 * sidebar slot, the sidebar itself can be dragged down to roughly 130px of
 * usable width, and this panel competes with the user's actual documents for
 * it. Hence the short labels, the 11px type, and tip bodies held to one line of
 * prose: anything longer wraps to five lines and the panel starts to look like
 * it is squatting.
 */

/**
 * `window.open` is blocked in some embedded contexts, so fall back to a
 * synthesised anchor click. Same helper shape as the IE Settings popup.
 */
const openDocs = (path: string) => {
  const url = `${IE_DOCS_BASE_URL}${path}`;
  const opened = window.open(url, '_blank');
  if (!opened || opened.closed) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => document.body.removeChild(link), 100);
  }
};

const containerStyle: React.CSSProperties = {
  backgroundColor: 'var(--rn-clr-background-elevation-10)',
  border: '1px solid var(--rn-clr-border-subtle)',
  color: 'var(--rn-clr-content-primary)',
  boxShadow: 'var(--rn-box-shadow-1)',
};

const iconButtonStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 5,
  border: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
  background: 'transparent',
  color: 'var(--rn-clr-content-secondary, #64748b)',
  fontSize: 11,
  lineHeight: '16px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 auto',
  padding: 0,
};

const actionButtonStyle: React.CSSProperties = {
  padding: '2px 5px',
  borderRadius: 5,
  border: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
  background: 'transparent',
  color: 'var(--rn-clr-content-secondary, #64748b)',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 500,
  cursor: 'pointer',
  textAlign: 'center',
  whiteSpace: 'nowrap',
};

/**
 * The Priority Review trio is one segmented control rather than three buttons:
 * the sidebar can be dragged to ~130px of usable width, and three separate
 * bordered buttons would spend ~10px of that on borders and gaps that say
 * nothing. Collapsing them into a single outline also says the right thing —
 * create, browse and clean are three doors onto the same feature.
 */
const segmentedGroupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  flex: '1 1 auto',
  minWidth: 0,
  height: 22,
  borderRadius: 5,
  border: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
  overflow: 'hidden',
};

/** A cell inside the group: no outline of its own, just a divider on its left. */
const segmentStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--rn-clr-content-secondary, #64748b)',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 500,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: 'none',
};

/** The icon cells are fixed; only the label cell gives ground as the panel narrows. */
const segmentIconStyle: React.CSSProperties = {
  ...segmentStyle,
  width: 22,
  flex: '0 0 auto',
  fontSize: 12,
  borderLeft: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
};

/**
 * The panel's title, as two words that are dropped whole rather than cut.
 *
 * A plain `truncate` on "Incremental RemNote" produces "Incremental Re…" in a
 * narrow sidebar, which reads as a different plugin's name. Losing the second
 * word entirely is the honest fallback: "Incremental" is still this plugin.
 *
 * CSS cannot express "hide the last word if it does not fit" — `overflow` cuts
 * mid-glyph and `text-overflow` only adds the ellipsis — so the width is
 * measured and the text chosen.
 *
 * Both halves of that measurement have a trap in them:
 *
 * - **The box must not be sized by its own text**, or the question answers
 *   itself: a box holding "Incremental" is only as wide as "Incremental", so
 *   the full name would never look like it fits again and the second word could
 *   never come back. It therefore *fills* the row (`flex: 1 1 auto` here and on
 *   the wrapper), which makes its width the space available and nothing else.
 * - **The comparison must be sub-pixel.** `clientWidth` and `scrollWidth` are
 *   rounded to integers, and `text-overflow` fires on an overflow of any size:
 *   a box 0.02px narrower than its text reports 70 against 70 and still paints
 *   "Incremen…", dropping three characters to make room for the ellipsis. The
 *   natural width comes from an out-of-flow probe and both sides are read as
 *   fractions, with a quarter-pixel of margin so a hairline fit renders the
 *   short form rather than an ellipsised long one.
 */
function PanelTitle() {
  const boxRef = useRef<HTMLSpanElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [showFull, setShowFull] = useState(true);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const probe = probeRef.current;
    if (!box || !probe) return;

    const measure = () =>
      setShowFull(
        probe.getBoundingClientRect().width <= box.getBoundingClientRect().width - 0.25
      );
    measure();

    // The box for the space available, the probe for the text's natural width —
    // which changes when a web font finishes loading, and would otherwise leave
    // the first measurement standing on the fallback font's metrics.
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(probe);
    return () => observer.disconnect();
  }, []);

  return (
    <span
      ref={boxRef}
      className="truncate"
      style={{ flex: '1 1 auto', minWidth: 0, position: 'relative', fontSize: 12.5, fontWeight: 600 }}
      title="Incremental RemNote"
    >
      {showFull ? 'Incremental RemNote' : 'Incremental'}
      <span
        ref={probeRef}
        aria-hidden
        // `width: max-content` matters: an absolutely positioned box with `auto`
        // width shrinks to fit its containing block, which is the very box being
        // measured — it would report the space available, not the text's width.
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 'max-content',
          visibility: 'hidden',
          pointerEvents: 'none',
          whiteSpace: 'pre',
        }}
      >
        Incremental RemNote
      </span>
    </span>
  );
}

function IconButton(props: {
  label: string;
  glyph: string;
  onClick: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={props.onClick}
      title={props.label}
      aria-label={props.label}
      className="hover:opacity-75"
      style={{ ...iconButtonStyle, ...props.style }}
    >
      {props.glyph}
    </button>
  );
}

/**
 * One tip, with its three answers. `onGotIt` retires it permanently and
 * `onClose` returns it to the pile; either way the tip area is done for this
 * session. `Learn More` is only rendered when the tip names a docs section.
 *
 * `All Tips` is the way out of the one-per-session pacing — it opens the whole
 * pile, answered ones first. The button row WRAPS rather than shrinking: three
 * labels need ~185px and the sidebar can be dragged to about 130px, so without
 * wrapping the third button would either overflow the panel or squeeze the
 * other two down to an ellipsis.
 */
function TipCard(props: {
  tip: OnboardingTip;
  onGotIt: () => void;
  onClose: () => void;
  onShowAll: () => void;
}) {
  const { tip } = props;
  return (
    <div
      style={{
        border: '1px solid var(--rn-clr-border-subtle)',
        borderRadius: 6,
        padding: 6,
        background: 'var(--rn-clr-background-primary, transparent)',
      }}
      className="flex flex-col gap-1"
    >
      <div className="flex items-start justify-between gap-1">
        <span style={{ fontSize: 12, fontWeight: 600, lineHeight: '15px' }}>💡 {tip.title}</span>
        <button
          onClick={props.onClose}
          title="Not now — this tip can come back later"
          aria-label="Dismiss this tip for now"
          className="hover:opacity-75"
          style={{ color: 'var(--rn-clr-content-tertiary)', flex: '0 0 auto', lineHeight: '15px' }}
        >
          ✕
        </button>
      </div>

      <div
        style={{ fontSize: 11, lineHeight: '14px', color: 'var(--rn-clr-content-secondary)' }}
      >
        {tip.body}
      </div>

      <div className="flex gap-1 mt-0.5" style={{ flexWrap: 'wrap' }}>
        <button
          onClick={props.onGotIt}
          // The background must be inline: an inline `background` in the shared
          // style would otherwise beat any Tailwind colour class here.
          style={{
            ...actionButtonStyle,
            flex: '1 1 0',
            border: '1px solid transparent',
            background: '#3b82f6',
            color: '#fff',
          }}
          className="hover:opacity-90"
        >
          I Got It
        </button>
        {tip.docsPath && (
          <button
            onClick={() => openDocs(tip.docsPath!)}
            style={{ ...actionButtonStyle, flex: '1 1 0' }}
            className="hover:opacity-75"
          >
            Learn More
          </button>
        )}
        <button
          onClick={props.onShowAll}
          style={{ ...actionButtonStyle, flex: '1 1 0' }}
          className="hover:opacity-75"
          title="See every tip — the ones you have acknowledged, with the date, and the ones still to come"
        >
          All Tips
        </button>
      </div>
    </div>
  );
}

export function PluginHub() {
  const plugin = usePlugin();

  const [tip, setTip] = useState<OnboardingTip | null>(null);
  /** null until the first load resolves, so the panel does not flash a tip in. */
  const [tipsReady, setTipsReady] = useState(false);

  // Drawn on mount rather than on a tracker: a tip that reshuffled every time
  // synced storage changed would move under the user's cursor.
  //
  // "Once per session" is enforced by the session flag, NOT by this effect
  // running once — RemNote remounts the SidebarEnd slot as the app is used, and
  // this effect runs again each time. Without the flag every remount re-drew,
  // which looks like variety while the pile is large and, once a category is
  // nearly exhausted, like the same handful of tips coming back after they were
  // answered.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Fire and forget: protecting the already-answered tips against a synced
      // wipe should never hold up painting the panel.
      backfillLocalMirror(plugin).catch(() => {
        /* best effort — the synced record is still authoritative */
      });

      if ((await tipAnsweredThisSession(plugin)) || (await tipsAreSnoozed(plugin))) {
        if (!cancelled) setTipsReady(true);
        return;
      }

      const acknowledged = await getAcknowledgedTipIds(plugin);
      if (cancelled) return;

      // A remount re-shows the tip this session already drew, rather than
      // rolling again: the session is entitled to one tip, and swapping it out
      // from under the user mid-session is the same complaint as repeating one.
      // It is re-checked against `acknowledged` because the All Tips popup can
      // retire it while the panel is up.
      const drawnId = await getDrawnTipIdThisSession(plugin);
      if (cancelled) return;
      const drawn = drawnId
        ? ONBOARDING_TIPS.find((t) => t.id === drawnId && !acknowledged.includes(t.id))
        : undefined;
      if (drawn) {
        setTip(drawn);
        setTipsReady(true);
        return;
      }

      const next = pickTip(acknowledged, await getLastShownMap(plugin));
      if (cancelled) return;
      setTip(next);
      setTipsReady(true);
      if (next) {
        // Stamped only on a fresh draw, so a remount cannot push a tip to the
        // back of the rotation the user never answered.
        await setDrawnTipIdThisSession(plugin, next.id);
        await recordTipShown(plugin, next.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plugin]);

  /**
   * Whether the user has closed the whole panel. Session storage, not local:
   * ✕ means "not now, I need the room", so the panel is back on the next start
   * — the same contract as the Mastery Drill notification, which resets its own
   * dismissal on mount. The "Show Plugin Panel" command brings it back sooner.
   */
  const hidden = useTrackerPlugin(
    async (rp) => (await rp.storage.getSession<boolean>(pluginHubHiddenKey)) ?? false,
    []
  );

  // Retire the tip and stop there — one tip per session. Handing back the next
  // one on acknowledgement turns the panel into a quiz the user did not ask for,
  // and the pile is meant to be drained over weeks, not in one sitting.
  const handleGotIt = useCallback(async () => {
    const current = tip;
    if (!current) return;
    await acknowledgeTip(plugin, current.id);
    await markTipAnsweredThisSession(plugin);
    setTip(null);
  }, [plugin, tip]);

  const handleCloseTip = useCallback(async () => {
    await snoozeTips(plugin);
    await markTipAnsweredThisSession(plugin);
    setTip(null);
  }, [plugin]);

  /**
   * The tip card is gone once the tip is answered and while the panel is
   * snoozed, so "All Tips" would be unreachable for the rest of the session
   * exactly when the user has just been reminded that tips exist. It therefore
   * also has a standing link below, and both go through here.
   */
  const openAllTips = useCallback(
    () => plugin.widget.openPopup(onboardingTipsWidgetId),
    [plugin]
  );

  const handleHidePanel = useCallback(async () => {
    await plugin.storage.setSession(pluginHubHiddenKey, true);
    await plugin.app.toast('Plugin panel hidden for this session. "Show Plugin Panel" brings it back.');
  }, [plugin]);

  /**
   * The scope for a Priority Review Document, resolved the same way the "Create
   * Priority Review Document" document-menu item resolves it — so the button is
   * that menu item, with the scope filled in for you.
   *
   * The focused Rem comes first; a click in the sidebar leaves the editor's
   * focus intact, so this is usually the Rem the user was last on. Failing that,
   * the document the focused pane has open, then the first open pane. A missing
   * scope is not an error: the creator still offers the whole knowledge base.
   */
  const openReviewDocumentCreator = useCallback(async () => {
    let scopeRemId: string | undefined;

    const focused = await plugin.focus.getFocusedRem();
    if (focused) {
      scopeRemId = focused._id;
    } else {
      const paneId = await plugin.window.getFocusedPaneId();
      scopeRemId = await plugin.window.getOpenPaneRemId(paneId);
      if (!scopeRemId) {
        const openIds = await plugin.window.getOpenPaneRemIds();
        scopeRemId = openIds?.[0];
      }
    }

    const scopeRem = scopeRemId ? await plugin.rem.findOne(scopeRemId) : undefined;
    const scopeName = scopeRem ? await safeRemTextToString(plugin, scopeRem.text) : 'Full KB';

    await plugin.storage.setSession('reviewDocContext', {
      scopeRemId: scopeRem?._id ?? null,
      scopeName,
    });
    await plugin.widget.openPopup('review_document_creator');
  }, [plugin]);

  /**
   * Opens the "Priority Review Queue" tag Rem — the one place every Priority
   * Review Document shows up, since the creator tags each document with it. Its
   * references list is the browsable index of past documents, and the queue can
   * be entered from any of them.
   *
   * The tag is created lazily by the first document, so its absence is not an
   * error state: it means there is nothing to browse yet, and the toast points
   * at the button that fixes that.
   */
  const openPriorityReviewQueue = useCallback(async () => {
    // Literal rather than the PRD_TAG_NAME export: that module pulls dayjs and
    // the IncRem cache in behind it, and this panel is mounted for the whole
    // session.
    const tagRem = await plugin.rem.findByName(['Priority Review Queue'], null);
    if (!tagRem) {
      await plugin.app.toast(
        'No Priority Review Documents yet — create one with the button to the left.'
      );
      return;
    }
    await plugin.window.openRem(tagRem);
  }, [plugin]);

  /** The "Clean Priority Review Documents" command, as a button. */
  const openPrdCleanup = useCallback(async () => {
    await plugin.widget.openPopup('prd_cleanup_popup');
  }, [plugin]);

  /**
   * What the Priority Review button will scope to, shown under it so the user is
   * not guessing which document they are about to collect. Tracked rather than
   * read once — the open document changes while the panel stays mounted.
   */
  const scopeName = useTrackerPlugin(async (rp) => {
    const focused = await rp.focus.getFocusedRem();
    let remId: string | undefined = focused?._id;
    if (!remId) {
      const paneId = await rp.window.getFocusedPaneId();
      remId = await rp.window.getOpenPaneRemId(paneId);
    }
    if (!remId) {
      const openIds = await rp.window.getOpenPaneRemIds();
      remId = openIds?.[0];
    }
    if (!remId) return null;
    const rem = await rp.rem.findOne(remId);
    if (!rem) return null;
    const name = await safeRemTextToString(rp, rem.text);
    return name.length > 28 ? name.slice(0, 28) + '…' : name;
  }, []);

  if (hidden) return null;

  return (
    <div style={containerStyle} className="flex flex-col gap-1.5 p-2 rounded-lg mb-2">
      <div className="flex items-center justify-between gap-1">
        {/* Fills the row so the title's width is the space left by the icons,
            not the width of whichever text it currently holds. */}
        <div className="flex items-center gap-1 min-w-0" style={{ flex: '1 1 auto' }}>
          <img
            src={`${plugin.rootURL}globe-icon.png`}
            alt=""
            style={{ width: 16, height: 16, flex: '0 0 auto' }}
          />
          <PanelTitle />
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton
            label="Keyboard shortcuts"
            glyph="⌨"
            onClick={() => openDocs('Keyboard-Shortcuts/')}
          />
          <IconButton
            label="Open the plugin's settings"
            glyph="⚙"
            onClick={() => plugin.widget.openPopup('ie_settings')}
          />
          <IconButton
            label="Open the documentation"
            glyph="?"
            onClick={() => openDocs('')}
          />
          <IconButton
            label="Hide this panel (bring it back with the “Show Plugin Panel” command)"
            glyph="✕"
            onClick={handleHidePanel}
          />
        </div>
      </div>

      <div className="flex gap-1">
        <button
          onClick={() => plugin.widget.openPopup('sorting_criteria')}
          // Sized to its own word, not to half the row: "Sorting" is a fixed
          // label that never needs more, while the Priority Review group has a
          // longer label plus two icon cells to fit. It still shrinks (0 1) if
          // the sidebar is dragged narrower than the two of them together.
          style={{
            ...actionButtonStyle,
            flex: '0 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          className="hover:opacity-75"
          title="Sorting Criteria — the mix of flashcards, incremental items and randomness in your queue"
        >
          Sorting
        </button>

        {/*
          Create / browse / clean, in the order you meet them. The label cell is
          the only one that flexes, and it truncates rather than overflowing its
          box the way a `nowrap` button does at sidebar widths.
        */}
        <div style={segmentedGroupStyle}>
          <button
            onClick={openReviewDocumentCreator}
            style={{
              ...segmentStyle,
              flex: '1 1 0',
              minWidth: 0,
              padding: '0 5px',
              // `display: block` is what makes the ellipsis work, and it costs
              // the flex centring — so the line box is the group's 20px inner
              // height instead.
              lineHeight: '20px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'block',
              textAlign: 'center',
            }}
            className="hover:opacity-75"
            title={
              scopeName
                ? `Create a Priority Review Document scoped to "${scopeName}"`
                : 'Create a Priority Review Document'
            }
          >
            Priority Review
          </button>
          <button
            onClick={openPriorityReviewQueue}
            style={segmentIconStyle}
            className="hover:opacity-75"
            title="Open the “Priority Review Queue” Rem — every Priority Review Document you have made, ready to study from"
            aria-label="Open the Priority Review Queue Rem"
          >
            👁
          </button>
          <button
            onClick={openPrdCleanup}
            style={segmentIconStyle}
            className="hover:opacity-75"
            title="Clean Priority Review Documents — remove the entries whose Rem no longer has anything due"
            aria-label="Clean Priority Review Documents"
          >
            🧹
          </button>
        </div>
      </div>

      {scopeName && (
        <div
          className="truncate"
          style={{ fontSize: 10.5, color: 'var(--rn-clr-content-tertiary)' }}
        >
          Scope: {scopeName}
        </div>
      )}

      {tipsReady && tip && (
        <TipCard
          tip={tip}
          onGotIt={handleGotIt}
          onClose={handleCloseTip}
          onShowAll={openAllTips}
        />
      )}

      {/* Standing entry to the pile for every state the tip card is absent in:
          answered, snoozed, or drained. Text rather than a header icon — the
          header is already four icons wide at a sidebar width where the panel
          title has to drop a word to fit. */}
      {tipsReady && !tip && (
        <button
          onClick={openAllTips}
          className="hover:opacity-75 text-left"
          style={{
            fontSize: 11,
            lineHeight: '14px',
            color: 'var(--rn-clr-content-tertiary)',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
          }}
          title="See every tip — the ones you have acknowledged, with the date, and the ones still to come"
        >
          💡 All tips
        </button>
      )}
    </div>
  );
}

renderWidget(PluginHub);
