import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import { allIncrementalRemKey } from '../lib/consts';
import { loadTrackedSites } from '../lib/duplicate_source';
import { SourceMatch, TrackedSite } from '../lib/duplicate_source/rules';
import { IncrementalRem } from '../lib/incremental_rem';

/** The Enter that ran a command from the Omnibar can reach the popup; ignore Enter this soon after opening. */
const ENTER_GRACE_MS = 300;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function siteSummary(site: TrackedSite) {
  const parts = [`${site.incremental} Incremental`];
  if (site.dismissed) parts.push(`${site.dismissed} Dismissed`);
  return parts.join(' · ');
}

function remDetail(rem: SourceMatch, schedule: IncrementalRem | undefined) {
  if (rem.status === 'dismissed') return 'Dismissed';
  if (!schedule) return 'Incremental';
  const date = new Date(schedule.nextRepDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `Priority ${schedule.priority} · ${schedule.nextRepDate <= Date.now() ? 'due' : 'next'} ${date}`;
}

/**
 * Opened by "Incremental Rems by Website". One search box serves both levels: it
 * filters the websites, then the Rems of the chosen one. Keys are read on the
 * container, so the arrows and Enter work while the box has the focus.
 */
export function SourceSitesPopup() {
  const plugin = usePlugin();
  const [sites, setSites] = useState<TrackedSite[] | null>(null);
  const [scanned, setScanned] = useState(true);
  const [schedules, setSchedules] = useState<Map<string, IncrementalRem>>(new Map());
  const [domain, setDomain] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      const [loaded, incRems] = await Promise.all([
        loadTrackedSites(plugin),
        plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
      ]);
      const start = ctx?.contextData?.domain as string | undefined;
      if (start && loaded.sites.some((site) => site.domain === start)) setDomain(start);
      setSchedules(new Map((incRems ?? []).map((incRem) => [incRem.remId, incRem])));
      setScanned(loaded.scanned);
      setSites(loaded.sites);
    })();
  }, []);

  // The box has to win focus against RemNote settling it after the popup opens.
  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      inputRef.current?.focus();
      if (document.activeElement === inputRef.current || ++tries >= 8) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, []);

  const site = sites?.find((candidate) => candidate.domain === domain) ?? null;
  const needle = query.trim().toLowerCase();

  const visibleSites = useMemo(
    () => (sites ?? []).filter((candidate) => candidate.domain.toLowerCase().includes(needle)),
    [sites, needle]
  );
  const visibleRems = useMemo(() => {
    const priorityOf = (rem: SourceMatch) => schedules.get(rem.remId)?.priority ?? 101;
    return (site?.rems ?? [])
      .filter((rem) => `${rem.name} ${rem.url}`.toLowerCase().includes(needle))
      .sort(
        (a, b) =>
          (a.status === 'dismissed' ? 1 : 0) - (b.status === 'dismissed' ? 1 : 0) ||
          priorityOf(a) - priorityOf(b) ||
          a.name.localeCompare(b.name)
      );
  }, [site, needle, schedules]);

  const rowCount = site ? visibleRems.length : visibleSites.length;

  useEffect(() => setSelected(0), [domain, needle]);
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, domain]);

  const enterSite = (name: string | null) => {
    setDomain(name);
    setQuery('');
    inputRef.current?.focus();
  };

  const openRem = async (remId: string) => {
    const rem = await plugin.rem.findOne(remId);
    if (rem) await plugin.window.openRem(rem);
    await plugin.widget.closePopup();
  };

  const activate = (index: number) => {
    if (site) {
      const rem = visibleRems[index];
      if (rem) void openRem(rem.remId);
    } else {
      const target = visibleSites[index];
      if (target) enterSite(target.domain);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (site) enterSite(null);
      else void plugin.widget.closePopup();
    } else if (e.key === 'ArrowDown' && rowCount) {
      e.preventDefault();
      setSelected((s) => (s + 1) % rowCount);
    } else if (e.key === 'ArrowUp' && rowCount) {
      e.preventDefault();
      setSelected((s) => (s + rowCount - 1) % rowCount);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (Date.now() - openedAt.current >= ENTER_GRACE_MS) activate(selected);
    }
  };

  const rowStyle = (isSelected: boolean): React.CSSProperties => ({
    background: isSelected ? 'var(--rn-clr-background-tertiary)' : 'transparent',
    border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))',
    color: 'var(--rn-clr-content-primary)',
    cursor: 'pointer',
    overflowWrap: 'anywhere',
    ...(isSelected ? { outline: '2px solid var(--rn-clr-border-accent, #3B82F6)', outlineOffset: '-2px' } : {}),
  });

  const secondary = { color: 'var(--rn-clr-content-secondary)' };

  return (
    <div onKeyDown={onKeyDown} className="flex flex-col gap-3 p-4" style={{ color: 'var(--rn-clr-content-primary)' }}>
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 18 }}>🌐</span>
        <span className="font-semibold text-base">{site ? site.domain : 'Incremental Rems by Website'}</span>
      </div>
      {sites && (
        <div className="text-xs" style={secondary}>
          {site ? siteSummary(site) : `${plural(sites.length, 'website')} · ${plural(sites.reduce((n, s) => n + s.rems.length, 0), 'Rem')}`}
        </div>
      )}

      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={site ? 'Filter by name or address…' : 'Filter websites…'}
        className="w-full py-1.5 px-2 text-sm rounded"
        style={{
          background: 'var(--rn-clr-background-primary)',
          color: 'var(--rn-clr-content-primary)',
          border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))',
        }}
      />

      <div ref={listRef} className="flex flex-col gap-1" style={{ maxHeight: 380, overflowY: 'auto' }}>
        {!sites && <div className="text-sm p-2" style={secondary}>Loading…</div>}
        {sites && !rowCount && (
          <div className="text-sm p-2" style={secondary}>
            {needle
              ? 'Nothing matches.'
              : scanned
                ? 'No Incremental or Dismissed Rem has a web page as a source.'
                : 'The list is still being built. It is ready a few minutes after RemNote starts on a computer.'}
          </div>
        )}
        {site
          ? visibleRems.map((rem, index) => (
              <button
                key={rem.remId}
                data-selected={selected === index}
                onClick={() => activate(index)}
                onMouseEnter={() => setSelected(index)}
                onMouseDown={(e) => e.preventDefault()}
                className="w-full py-2 px-3 text-sm rounded text-left"
                style={rowStyle(selected === index)}
              >
                <div className="font-medium">{rem.name}</div>
                <div className="text-xs mt-0.5" style={secondary}>{remDetail(rem, schedules.get(rem.remId))}</div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--rn-clr-content-tertiary)' }}>{rem.url}</div>
              </button>
            ))
          : visibleSites.map((candidate, index) => (
              <button
                key={candidate.domain}
                data-selected={selected === index}
                onClick={() => activate(index)}
                onMouseEnter={() => setSelected(index)}
                onMouseDown={(e) => e.preventDefault()}
                className="w-full py-2 px-3 text-sm rounded text-left flex items-center justify-between gap-3"
                style={rowStyle(selected === index)}
              >
                <span className="font-medium">{candidate.domain}</span>
                <span className="text-xs" style={{ ...secondary, flexShrink: 0 }}>{siteSummary(candidate)}</span>
              </button>
            ))}
      </div>

      <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
        {site ? '↑↓ choose · Enter open · Esc all websites' : '↑↓ choose · Enter show its Rems · Esc close'}
      </div>
    </div>
  );
}

renderWidget(withHoverTips(SourceSitesPopup));
