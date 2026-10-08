// Editor selection helpers + Omnibar-resilient resolution.
//
// Background: Cmd+/ Omnibar steals editor focus before our command's `action`
// runs. By that point, plugin.editor.getSelection() / getSelectedRem() / focus
// all return undefined — RemNote's internal commands work because they capture
// the selection synchronously when the palette opens, but plugins have no
// such hook. This module caches every positive selection event into session
// storage and exposes a drop-in replacement for getSelection() that falls back
// to that cache.

import {
  AppEvents,
  RNPlugin,
  SelectionType,
} from '@remnote/plugin-sdk';

export const SELECTION_CACHE_KEY = 'lastEditorSelectionCache';
export const SELECTION_CACHE_TTL_MS = 20_000;

/** Which of getEffectiveSelection's three sources answered. */
export type SelectionSource = 'live' | 'selected-rem' | 'cache';

export type CachedSelection =
  | { kind: 'rem'; remIds: string[]; capturedAt: number }
  | { kind: 'text'; remId: string; capturedAt: number };

// Subscribe to EditorSelectionChanged once at plugin startup. The handler
// only WRITES on positive events, so the cache survives Omnibar focus shifts
// (which fire a clear-selection event that we deliberately ignore).
export function registerSelectionTracker(plugin: RNPlugin) {
  plugin.event.addListener(
    AppEvents.EditorSelectionChanged,
    undefined,
    async () => {
      try {
        const sel = await plugin.editor.getSelection();
        if (
          sel?.type === SelectionType.Rem &&
          (sel as any).remIds?.length > 0
        ) {
          const entry: CachedSelection = {
            kind: 'rem',
            remIds: (sel as any).remIds,
            capturedAt: Date.now(),
          };
          await plugin.storage.setSession(SELECTION_CACHE_KEY, entry);
        } else if (
          sel?.type === SelectionType.Text &&
          (sel as any).remId
        ) {
          const entry: CachedSelection = {
            kind: 'text',
            remId: (sel as any).remId,
            capturedAt: Date.now(),
          };
          await plugin.storage.setSession(SELECTION_CACHE_KEY, entry);
        }
        // null / undefined / empty selection: leave the cache alone.
      } catch {
        /* best-effort tracker; never throw from a listener */
      }
    }
  );
}

// Drop-in replacement for `plugin.editor.getSelection()`. Order of precedence:
//   1. live getSelection() — works for direct shortcut invocations.
//   2. live getSelectedRem() — sometimes survives focus shifts.
//   3. fresh cache entry from registerSelectionTracker (above).
// Returns a value in the SDK's RemSelection|TextSelection shape so callers
// can drop it in without other refactor.
export async function getEffectiveSelection(plugin: RNPlugin): Promise<any> {
  return (await getEffectiveSelectionWithSource(plugin)).selection;
}

// Drop the cached selection. Called on entering a queue: a selection made in
// the editor says nothing about what the user wants once a card is on screen,
// yet queue commands let a selection outrank the card (for the previewer).
export async function clearSelectionCache(plugin: RNPlugin): Promise<void> {
  await plugin.storage.setSession(SELECTION_CACHE_KEY, undefined);
}

export async function getEffectiveSelectionWithSource(
  plugin: RNPlugin
): Promise<{ selection: any; source?: SelectionSource }> {
  const live = await plugin.editor.getSelection();
  if (live) return { selection: live, source: 'live' };

  const remSel = await (plugin.editor as any).getSelectedRem?.();
  if (remSel?.remIds?.length) return { selection: remSel, source: 'selected-rem' };

  const cached =
    (await plugin.storage.getSession<CachedSelection>(
      SELECTION_CACHE_KEY
    )) || null;
  const ageMs = cached ? Date.now() - cached.capturedAt : Infinity;
  if (!cached || ageMs >= SELECTION_CACHE_TTL_MS) return { selection: undefined };

  if (cached.kind === 'rem') {
    return {
      selection: { type: SelectionType.Rem, remIds: cached.remIds },
      source: 'cache',
    };
  }
  // Single-rem cache → synthesize a zero-width text-cursor selection. The
  // richText/range fields are required by the SDK type but unused by the
  // multi-rem code paths we care about (they only read remId).
  return {
    selection: {
      type: SelectionType.Text,
      remId: cached.remId,
      richText: [],
      isReverse: false,
      range: { start: 0, end: 0 },
    },
    source: 'cache',
  };
}
