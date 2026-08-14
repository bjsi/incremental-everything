import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useState } from 'react';
import '../style.css';
import '../App.css';
import { IE_DOCS_BASE_URL } from '../lib/settings';
import { safeRemTextToString } from '../lib/pdfUtils';
import {
  OnboardingTip,
  acknowledgeTip,
  getAcknowledgedTipIds,
  pickTip,
  snoozeTips,
  tipsAreSnoozed,
} from '../lib/onboarding_tips';

/**
 * The "Incremental Plugin" sidebar hub.
 *
 * The plugin's surface is spread across a slash-command list, a settings popup,
 * two document menus and a dozen shortcuts, none of which announce themselves.
 * This panel is the one fixed place that does: four things a new user needs
 * within reach, and one tip at a time from the onboarding pile.
 *
 * It sits in `SidebarEnd` next to the Mastery Drill notification, and is not
 * gated behind a setting — it is the entry point, so it has to be there before
 * the user knows there are settings to find.
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
  width: 22,
  height: 22,
  borderRadius: 6,
  border: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
  background: 'transparent',
  color: 'var(--rn-clr-content-secondary, #64748b)',
  fontSize: 12,
  lineHeight: '20px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 auto',
};

const actionButtonStyle: React.CSSProperties = {
  flex: '1 1 0',
  padding: '4px 6px',
  borderRadius: 6,
  border: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
  background: 'var(--rn-clr-background-primary, transparent)',
  color: 'var(--rn-clr-content-secondary, #64748b)',
  fontSize: 11,
  fontWeight: 500,
  cursor: 'pointer',
  textAlign: 'center',
};

function IconButton(props: { label: string; glyph: string; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      title={props.label}
      aria-label={props.label}
      className="hover:opacity-75"
      style={iconButtonStyle}
    >
      {props.glyph}
    </button>
  );
}

/**
 * One tip, with its three answers. `onGotIt` retires it permanently, `onClose`
 * returns it to the pile, `Learn More` is only rendered when the tip names a
 * docs section.
 */
function TipCard(props: { tip: OnboardingTip; onGotIt: () => void; onClose: () => void }) {
  const { tip } = props;
  return (
    <div
      style={{
        border: '1px solid var(--rn-clr-border-subtle)',
        borderRadius: 8,
        padding: 8,
        background: 'var(--rn-clr-background-primary, transparent)',
      }}
      className="flex flex-col gap-1"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold">💡 {tip.title}</span>
        <button
          onClick={props.onClose}
          title="Not now — this tip can come back later"
          aria-label="Dismiss this tip for now"
          className="hover:opacity-75"
          style={{ color: 'var(--rn-clr-content-tertiary)', flex: '0 0 auto' }}
        >
          ✕
        </button>
      </div>

      <div className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
        {tip.body}
      </div>

      <div className="flex gap-1 mt-1">
        <button
          onClick={props.onGotIt}
          style={{ ...actionButtonStyle, borderColor: 'transparent' }}
          className="bg-blue-500 hover:bg-blue-600 text-white"
        >
          I Got It
        </button>
        {tip.docsPath && (
          <button
            onClick={() => openDocs(tip.docsPath!)}
            style={actionButtonStyle}
            className="hover:opacity-75"
          >
            Learn More
          </button>
        )}
      </div>
    </div>
  );
}

export function PluginHub() {
  const plugin = usePlugin();

  const [tip, setTip] = useState<OnboardingTip | null>(null);
  /** null until the first load resolves, so the panel does not flash a tip in. */
  const [tipsReady, setTipsReady] = useState(false);

  // Drawn once per mount rather than on a tracker: a tip that reshuffled every
  // time synced storage changed would move under the user's cursor.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (await tipsAreSnoozed(plugin)) {
        if (!cancelled) setTipsReady(true);
        return;
      }
      const acknowledged = await getAcknowledgedTipIds(plugin);
      if (cancelled) return;
      setTip(pickTip(acknowledged));
      setTipsReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [plugin]);

  const handleGotIt = useCallback(async () => {
    const current = tip;
    if (!current) return;
    await acknowledgeTip(plugin, current.id);
    const acknowledged = await getAcknowledgedTipIds(plugin);
    setTip(pickTip(acknowledged, current.id));
  }, [plugin, tip]);

  const handleCloseTip = useCallback(async () => {
    await snoozeTips(plugin);
    setTip(null);
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
    return name.length > 34 ? name.slice(0, 34) + '…' : name;
  }, []);

  return (
    <div style={containerStyle} className="flex flex-col gap-2 p-3 rounded-lg mb-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span style={{ fontSize: 16, lineHeight: '16px' }}>🌐</span>
          <span className="font-semibold text-sm truncate">Incremental Plugin</span>
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            label="Open the plugin's settings"
            glyph="⚙️"
            onClick={() => plugin.widget.openPopup('ie_settings')}
          />
          <IconButton
            label="Open the documentation"
            glyph="?"
            onClick={() => openDocs('')}
          />
        </div>
      </div>

      <div className="flex gap-1">
        <button
          onClick={() => plugin.widget.openPopup('sorting_criteria')}
          style={actionButtonStyle}
          className="hover:opacity-75"
          title="Set the mix of flashcards, incremental items and randomness in your queue"
        >
          Sorting Criteria
        </button>
        <button
          onClick={openReviewDocumentCreator}
          style={actionButtonStyle}
          className="hover:opacity-75"
          title={
            scopeName
              ? `Create a Priority Review Document scoped to "${scopeName}"`
              : 'Create a Priority Review Document'
          }
        >
          Priority Review
        </button>
      </div>

      {scopeName && (
        <div className="text-xs truncate" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
          Review scope: {scopeName}
        </div>
      )}

      {tipsReady && tip && (
        <TipCard tip={tip} onGotIt={handleGotIt} onClose={handleCloseTip} />
      )}
    </div>
  );
}

renderWidget(PluginHub);
