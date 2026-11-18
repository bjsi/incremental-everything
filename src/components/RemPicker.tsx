/**
 * The Rem picker of Search & Browse's Move and Tag: our take on RemNote's Move Bullet
 * popup, which plugins cannot open (it is `showSetParentPopup` on the host's own Rem
 * object, with no bridge to it). Drawn inside the browser panel, over the table.
 *
 * Search comes from the AI helper (scripts/rem_browse.py pick): all words must match,
 * documents and folders come first. As in RemNote's hierarchical search:
 *   Tab        enters the highlighted Rem: it becomes a scope chip, and the list shows
 *              its children (or, while typing, what matches under it);
 *   Shift+Tab  goes back up one level;
 *   Backspace  in an empty box leaves every scope (back to the whole knowledge base);
 *   ↑ ↓ Enter  choose; Esc cancels.
 * Keys are handled on the container, never on the buttons (house rule for popups).
 */
import type { RNPlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { pickViaHelper, type PickRow } from '../lib/rem_search_client';
import { loadPickerRecents } from '../lib/search_browse';

export type PickChoice =
  | { kind: 'rem'; row: PickRow }
  | { kind: 'top' }
  | { kind: 'remove'; id: string; name: string }
  /** A new Rem named `name`, created under `parentId` (the scope; null: top level). */
  | { kind: 'create'; name: string; parentId: string | null };

type Item =
  | { key: string; kind: 'top' }
  | { key: string; kind: 'remove'; id: string; name: string; count: number }
  | { key: string; kind: 'rem'; row: PickRow }
  | { key: string; kind: 'create'; name: string };

interface Props {
  plugin: RNPlugin;
  title: string;
  /** Names of the Rems acted on (chips under the title). */
  chips: string[];
  placeholder: string;
  recentsKind: 'move' | 'tag';
  enterLabel: string;
  /** Move: "No parent: make them top-level". */
  topLevelOption?: boolean;
  /** Tag: tags on the Rems, offered for removal while the box is empty. */
  removable?: { id: string; name: string; count: number }[];
  /** What "+ Create … “text”" makes (always offered at the bottom while typing; ⌘Enter). */
  createNoun: string;
  /** Rems that can't be chosen (Move: the moved Rems), with why. */
  disabledReason?: (row: PickRow) => string | null;
  onPick: (choice: PickChoice) => void;
  onClose: () => void;
}

const RING = '2px solid var(--rn-clr-border-accent, #3B82F6)';
const ACTIVE_BG = 'color-mix(in srgb, var(--rn-clr-border-accent, #3B82F6) 12%, var(--rn-clr-background-primary, #fff))';

export function RemPicker(props: Props) {
  const { plugin } = props;
  const [text, setText] = React.useState('');
  const [scopes, setScopes] = React.useState<PickRow[]>([]);
  const [rows, setRows] = React.useState<PickRow[]>([]);
  const [recents, setRecents] = React.useState<PickRow[]>([]);
  const [active, setActive] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const reqRef = React.useRef(0);
  const scope = scopes[scopes.length - 1] ?? null;

  React.useEffect(() => {
    inputRef.current?.focus();
    (async () => {
      const ids = await loadPickerRecents(plugin, props.recentsKind);
      if (!ids.length) return;
      const res = await pickViaHelper(plugin, { ids });
      if (res.status === 'ok') setRecents(res.rows);
    })();
  }, [plugin, props.recentsKind]);

  // The list: children of the scope, or what the words match (in the scope).
  React.useEffect(() => {
    const q = text.trim();
    if (!q && !scope) {
      setRows([]);
      setError(null);
      return;
    }
    const req = ++reqRef.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      const res = await pickViaHelper(plugin, { text: q, scope: scope?.remId ?? null });
      if (req !== reqRef.current) return;
      setLoading(false);
      if (res.status === 'ok') {
        setRows(res.rows);
        setError(null);
      } else if (res.status === 'query-error') {
        setRows([]);
        setError(res.error.message);
      } else if (res.status === 'outdated') {
        setError('The AI helper running on this computer is older than this picker: restart it from the latest scripts.');
      } else if (res.status === 'unpaired') {
        setError('The AI helper is running but not paired: paste its token in the plugin settings.');
      } else {
        setError('The picker needs the AI helper running on this computer.');
      }
    }, q ? 160 : 0);
    return () => clearTimeout(timer);
  }, [plugin, text, scope]);

  const items: Item[] = React.useMemo(() => {
    const q = text.trim();
    const out: Item[] = [];
    if (!q && !scope) {
      if (props.topLevelOption) out.push({ key: 'top', kind: 'top' });
      for (const t of props.removable ?? []) out.push({ key: `rm-${t.id}`, kind: 'remove', id: t.id, name: t.name, count: t.count });
      for (const r of recents) out.push({ key: `rc-${r.remId}`, kind: 'rem', row: r });
      return out;
    }
    for (const r of rows) out.push({ key: `r-${r.remId}`, kind: 'rem', row: r });
    if (q) out.push({ key: 'create', kind: 'create', name: q });
    return out;
  }, [text, scope, rows, recents, props.topLevelOption, props.removable]);

  React.useEffect(() => setActive(0), [items.length, scope, text]);
  React.useEffect(() => {
    listRef.current?.querySelector(`[data-pick-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  /** Creating under a scope that can't be chosen (Move: a moved Rem) is blocked too. */
  const scopeReason = scope && props.disabledReason ? props.disabledReason(scope) : null;
  const reasonFor = (it: Item) =>
    it.kind === 'rem' && props.disabledReason ? props.disabledReason(it.row) : it.kind === 'create' ? scopeReason : null;

  const choose = (it: Item | undefined) => {
    if (!it || reasonFor(it)) return;
    if (it.kind === 'rem') props.onPick({ kind: 'rem', row: it.row });
    else if (it.kind === 'top') props.onPick({ kind: 'top' });
    else if (it.kind === 'remove') props.onPick({ kind: 'remove', id: it.id, name: it.name });
    else props.onPick({ kind: 'create', name: it.name, parentId: scope?.remId ?? null });
  };

  /** ⌘Enter, as in RemNote's own dialogs: create from the typed text. */
  const create = () => {
    const q = text.trim();
    if (q && !scopeReason) props.onPick({ kind: 'create', name: q, parentId: scope?.remId ?? null });
  };

  const enter = (it: Item | undefined) => {
    if (it?.kind !== 'rem') return;
    setScopes([...scopes, it.row]);
    setText('');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The panel under us must not see these keys (its own ↑↓/Enter/Esc).
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      create();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      if (scopes.length) {
        setScopes(scopes.slice(0, -1));
        setText('');
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      enter(items[active]);
    } else if (e.key === 'Backspace' && !text && scopes.length) {
      e.preventDefault();
      setScopes([]);
    }
  };

  const chipStyle: React.CSSProperties = {
    padding: '3px 8px',
    borderRadius: '6px',
    background: 'var(--rn-clr-background-secondary)',
    fontSize: '12px',
    maxWidth: '260px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  const shown = props.chips.slice(0, 2);
  const more = props.chips.length - shown.length;
  const icon = (r: PickRow) => (r.isFolder ? '📁' : r.isDocument ? '📄' : '•');
  const section = (label: string) => (
    <div style={{ padding: '8px 12px 4px', fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
      {label}
    </div>
  );

  const q = text.trim();
  let lastSection = '';
  const sectionOf = (it: Item) =>
    !q && !scope
      ? it.kind === 'remove'
        ? 'On these Rems — Enter removes'
        : it.kind === 'rem'
          ? 'Recents'
          : ''
      : it.kind === 'rem' && !q
        ? `In ${scope?.name || 'this Rem'}`
        : '';

  return (
    <div
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 5,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 16px',
        background: 'color-mix(in srgb, var(--rn-clr-background-primary, #fff) 40%, transparent)',
        borderRadius: '10px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        style={{
          width: 'min(760px, 100%)',
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--rn-clr-background-primary)',
          border: '1px solid var(--rn-clr-border-opaque, #d1d5db)',
          borderRadius: '12px',
          boxShadow: '0 16px 48px rgba(0,0,0,0.35)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '14px 16px 8px' }}>
          <div style={{ fontWeight: 700, fontSize: '16px', marginBottom: '8px' }}>{props.title}</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {shown.map((c, i) => (
              <span key={i} style={chipStyle} title={c}>
                {c || '(no text)'}
              </span>
            ))}
            {more > 0 && <span style={chipStyle}>{more} more…</span>}
          </div>
        </div>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', padding: '8px 16px', borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}
          onClick={() => inputRef.current?.focus()}
        >
          {scopes.map((s, i) => (
            <span
              key={s.remId}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setScopes(scopes.slice(0, i + 1));
                setText('');
              }}
              style={{ ...chipStyle, cursor: 'pointer', fontWeight: 600 }}
              title={`Back to ${s.name}`}
            >
              {s.name || '(no text)'} ›
            </span>
          ))}
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={scope ? `Search within ${scope.name || 'this Rem'}…` : props.placeholder}
            style={{
              flex: 1,
              minWidth: '200px',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--rn-clr-content-primary)',
              fontSize: '14px',
              padding: '6px 2px',
            }}
          />
          {loading && <span style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>…</span>}
        </div>
        <div ref={listRef} style={{ flex: 1, minHeight: '120px', overflowY: 'auto', padding: '4px 0' }}>
          {error && <div style={{ padding: '10px 16px', fontSize: '12px', color: 'var(--rn-clr-red, #c0392b)' }}>{error}</div>}
          {!error && items.length === 0 && (
            <div style={{ padding: '10px 16px', fontSize: '12px', color: 'var(--rn-clr-content-tertiary)' }}>
              {q ? (loading ? 'Searching…' : 'Nothing matches.') : scope ? 'No children.' : 'Type to search.'}
            </div>
          )}
          {items.map((it, i) => {
            const sec = sectionOf(it);
            const head = sec && sec !== lastSection ? section(sec) : null;
            if (sec) lastSection = sec;
            const reason = reasonFor(it);
            const isActive = i === active;
            return (
              <React.Fragment key={it.key}>
                {head}
                <div
                  data-pick-index={i}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => active !== i && setActive(i)}
                  onClick={() => choose(it)}
                  title={reason ?? undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    margin: '0 8px',
                    padding: '7px 10px',
                    borderRadius: '8px',
                    cursor: reason ? 'not-allowed' : 'pointer',
                    opacity: reason ? 0.45 : 1,
                    background: isActive ? ACTIVE_BG : undefined,
                    outline: isActive ? RING : 'none',
                    outlineOffset: '-2px',
                  }}
                >
                  {it.kind === 'top' && (
                    <>
                      <span style={{ width: '20px', textAlign: 'center' }}>⤴</span>
                      <span>No parent: make {props.chips.length === 1 ? 'it a top-level Rem' : 'them top-level Rems'}</span>
                    </>
                  )}
                  {it.kind === 'remove' && (
                    <>
                      <span style={{ width: '20px', textAlign: 'center', color: 'var(--rn-clr-red, #c0392b)' }}>−</span>
                      <span>
                        Remove <strong>{it.name}</strong>
                        <span style={{ color: 'var(--rn-clr-content-tertiary)' }}> · on {it.count}</span>
                      </span>
                    </>
                  )}
                  {it.kind === 'create' && (
                    <>
                      <span style={{ width: '20px', textAlign: 'center' }}>＋</span>
                      <span style={{ minWidth: 0, flex: 1 }}>
                        Create {props.createNoun} <strong>“{it.name}”</strong>
                        {scope && <span style={{ color: 'var(--rn-clr-content-tertiary)' }}> in {scope.name || 'this Rem'}</span>}
                      </span>
                      <span style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', flexShrink: 0 }}>⌘↵</span>
                    </>
                  )}
                  {it.kind === 'rem' && (
                    <>
                      <span style={{ width: '20px', textAlign: 'center', flexShrink: 0 }}>{icon(it.row)}</span>
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: it.row.isDocument ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {it.row.name || <em style={{ opacity: 0.6 }}>(no text)</em>}
                        </div>
                        {it.row.path.length > 0 && (
                          <div
                            style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            title={it.row.path.join(' / ')}
                          >
                            {it.row.path.join(' / ')}
                          </div>
                        )}
                      </span>
                      {reason ? (
                        <span style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>{reason}</span>
                      ) : (
                        it.row.hasChildren &&
                        isActive && <span style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', flexShrink: 0 }}>Tab ›</span>
                      )}
                    </>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div
          style={{
            display: 'flex',
            gap: '14px',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            padding: '8px 16px',
            borderTop: '1px solid var(--rn-clr-background-tertiary)',
            fontSize: '11px',
            color: 'var(--rn-clr-content-secondary)',
          }}
        >
          <span>↑↓ select</span>
          <span>Tab search within children</span>
          <span>⇧Tab up one level</span>
          <span>⌫ (empty) whole KB</span>
          <span>↵ {props.enterLabel}</span>
          <span>⌘↵ create {props.createNoun}</span>
          <span>Esc cancel</span>
        </div>
      </div>
    </div>
  );
}
