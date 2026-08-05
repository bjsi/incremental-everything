import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { CSSProperties, useMemo, useState } from 'react';
import {
  IE_DOCS_BASE_URL,
  IE_SETTINGS_DEFAULTS,
  IE_SETTINGS_SCHEMA,
  IE_SETTING_GROUPS,
  IE_SETTING_IDS_BY_GROUP,
  IESettingId,
  IESettings,
  SettingGroupId,
  SettingSpec,
  getIESetting,
  setIESetting,
  isSettingVisible,
  hiddenDependentsOf,
} from '../lib/settings';

/**
 * The IE Settings popup: every setting the plugin owns, grouped and layered,
 * because RemNote's own panel renders three dozen entries as one flat list.
 *
 * Native-tier settings (see lib/settings.ts) are shown read-only with a pointer
 * to RemNote's panel: the SDK has no setter for a registered setting, and those
 * particular ones are deliberately kept where they stay reachable when the
 * plugin itself is misbehaving.
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

const isDefault = (id: IESettingId, value: unknown) =>
  JSON.stringify(value) === JSON.stringify(IE_SETTINGS_DEFAULTS[id]);

/**
 * How to tell the user to reveal the settings this one gates. A switch can gate
 * in either direction — the Beta Scheduler hides its parameters when off and
 * hides the Multiplier when on — so the phrase follows the required value.
 */
function requirementPhrase(spec: SettingSpec, requires: unknown): string {
  // A native-tier switch cannot be flipped here, so say where it lives rather
  // than pointing at a control the popup renders disabled.
  const where = spec.tier === 'native' ? " in RemNote's settings" : '';
  if (spec.kind === 'boolean') {
    return `Turn this ${requires ? 'on' : 'off'}${where} to configure`;
  }
  if (spec.kind === 'dropdown') {
    const label = spec.options.find((o) => o.value === requires)?.label ?? String(requires);
    return `Set this to “${label}”${where} to configure`;
  }
  return `Set this to ${JSON.stringify(requires)}${where} to configure`;
}

function HelpLink({ path, label }: { path: string; label: string }) {
  return (
    <button
      onClick={() => openDocs(path)}
      title={`Open the documentation: ${label}`}
      aria-label={`Open the documentation: ${label}`}
      style={{
        width: 18,
        height: 18,
        borderRadius: '50%',
        border: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
        background: 'transparent',
        color: 'var(--rn-clr-content-secondary, #64748b)',
        fontSize: 11,
        fontWeight: 700,
        lineHeight: '16px',
        cursor: 'pointer',
        flexShrink: 0,
        padding: 0,
      }}
    >
      ?
    </button>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: 'neutral' | 'warn' }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: '1px 6px',
        borderRadius: 4,
        whiteSpace: 'nowrap',
        color: tone === 'warn' ? '#b45309' : 'var(--rn-clr-content-tertiary, #94a3b8)',
        backgroundColor:
          tone === 'warn' ? 'rgba(245, 158, 11, 0.14)' : 'var(--rn-clr-background-tertiary, #f1f5f9)',
      }}
    >
      {children}
    </span>
  );
}

interface RowProps {
  id: IESettingId;
  spec: SettingSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Settings hidden because they depend on this one, grouped by required value. */
  hiddenDependents: Array<{ requires: unknown; ids: IESettingId[] }>;
}

function SettingRow({ id, spec, value, onChange, hiddenDependents }: RowProps) {
  const readOnly = spec.tier === 'native';
  // Text and number inputs keep a local draft so that typing is not fought by
  // the reactive value coming back from storage; committed on blur / Enter.
  const [draft, setDraft] = useState<string | null>(null);

  const inputStyle: CSSProperties = {
    fontSize: 12,
    padding: '4px 8px',
    border: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
    borderRadius: 6,
    backgroundColor: 'var(--rn-clr-background-primary, #fff)',
    color: 'var(--rn-clr-content-primary, #0f172a)',
    opacity: readOnly ? 0.6 : 1,
  };

  const commitNumber = (raw: string) => {
    setDraft(null);
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const spec2 = spec as Extract<SettingSpec, { kind: 'number' }>;
    let v = spec2.integer ? Math.round(n) : n;
    if (spec2.min !== undefined) v = Math.max(spec2.min, v);
    if (spec2.max !== undefined) v = Math.min(spec2.max, v);
    onChange(v);
  };

  const control = () => {
    switch (spec.kind) {
      case 'boolean':
        return (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: readOnly ? 'default' : 'pointer' }}>
            <input
              type="checkbox"
              checked={!!value}
              disabled={readOnly}
              onChange={(e) => onChange(e.target.checked)}
              style={{ width: 15, height: 15, cursor: readOnly ? 'default' : 'pointer' }}
            />
            <span style={{ fontSize: 12, color: 'var(--rn-clr-content-secondary, #475569)' }}>
              {value ? 'On' : 'Off'}
            </span>
          </label>
        );
      case 'number':
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="number"
              value={draft ?? String(value ?? '')}
              disabled={readOnly}
              min={spec.min}
              max={spec.max}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={(e) => commitNumber(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitNumber((e.target as HTMLInputElement).value);
              }}
              style={{ ...inputStyle, width: 92 }}
            />
            {spec.unit && (
              <span style={{ fontSize: 11, color: 'var(--rn-clr-content-tertiary, #94a3b8)' }}>{spec.unit}</span>
            )}
          </div>
        );
      case 'string':
        return (
          <input
            type="text"
            value={draft ?? String(value ?? '')}
            disabled={readOnly}
            placeholder={spec.placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => {
              setDraft(null);
              onChange(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            style={{ ...inputStyle, width: spec.wide ? '100%' : 220, fontFamily: spec.wide ? 'monospace' : undefined }}
          />
        );
      case 'dropdown':
        return (
          <select
            value={String(value ?? '')}
            disabled={readOnly}
            onChange={(e) => onChange(e.target.value)}
            style={{ ...inputStyle, minWidth: 220, cursor: readOnly ? 'default' : 'pointer' }}
          >
            {spec.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
    }
  };

  const modified = !readOnly && !isDefault(id, value);

  return (
    <div
      style={{
        padding: '12px 0',
        borderBottom: '1px solid var(--rn-clr-background-tertiary, #f1f5f9)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{spec.title}</span>
        {spec.helpPath && <HelpLink path={spec.helpPath} label={spec.title} />}
        {spec.reloadRequired && <Badge tone="neutral">needs reload</Badge>}
        {readOnly && <Badge tone="neutral">RemNote settings</Badge>}
        {modified && <Badge tone="neutral">modified</Badge>}
      </div>

      {spec.warning && (
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.5,
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid rgba(245, 158, 11, 0.45)',
            backgroundColor: 'rgba(245, 158, 11, 0.10)',
            color: 'var(--rn-clr-content-primary, #0f172a)',
          }}
        >
          <strong>⚠️ </strong>
          {spec.warning}
        </div>
      )}

      {spec.description.split('\n\n').map((para, i) => (
        <div
          key={i}
          style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--rn-clr-content-secondary, #475569)' }}
        >
          {para}
        </div>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {control()}
        {readOnly ? (
          <span style={{ fontSize: 11, color: 'var(--rn-clr-content-tertiary, #94a3b8)' }}>
            Change this in Settings → Plugins → Incremental Everything. It is kept there on purpose, so it stays
            reachable if the plugin is slow or failing to load.
          </span>
        ) : (
          modified && (
            <button
              onClick={() => onChange(IE_SETTINGS_DEFAULTS[id])}
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 5,
                border: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
                backgroundColor: 'transparent',
                color: 'var(--rn-clr-content-secondary, #475569)',
                cursor: 'pointer',
              }}
              title={`Reset to ${JSON.stringify(IE_SETTINGS_DEFAULTS[id])}`}
            >
              Reset
            </button>
          )
        )}
      </div>

      {hiddenDependents.map((dep) => (
        <div
          key={JSON.stringify(dep.requires)}
          style={{ fontSize: 11, fontStyle: 'italic', color: 'var(--rn-clr-content-tertiary, #94a3b8)' }}
        >
          {requirementPhrase(spec, dep.requires)}{' '}
          {dep.ids.map((depId) => IE_SETTINGS_SCHEMA[depId].title).join(' and ')}.
        </div>
      ))}
    </div>
  );
}

export function IESettingsWidget() {
  const plugin = usePlugin();
  const [activeGroup, setActiveGroup] = useState<SettingGroupId>('flashcardPriority');
  const [search, setSearch] = useState('');

  const allIds = useMemo(() => Object.keys(IE_SETTINGS_SCHEMA) as IESettingId[], []);

  // One tracker for the whole set: re-runs when the synced blob or any native
  // setting changes, so the popup reflects edits made anywhere.
  const values = useTrackerPlugin(async (rp) => {
    const entries = await Promise.all(allIds.map(async (id) => [id, await getIESetting(rp, id)] as const));
    return Object.fromEntries(entries) as unknown as IESettings;
  }, [allIds]);

  const query = search.trim().toLowerCase();
  // A setting whose parent switch is off is hidden everywhere, search included:
  // configuring a scheduler you have turned off is exactly the noise the popup
  // exists to remove.
  const visible = (id: IESettingId) => isSettingVisible(id, values);
  const matches = (id: IESettingId) => {
    if (!visible(id)) return false;
    if (!query) return true;
    const spec = IE_SETTINGS_SCHEMA[id];
    return (
      spec.title.toLowerCase().includes(query) ||
      spec.description.toLowerCase().includes(query) ||
      id.toLowerCase().includes(query)
    );
  };

  const modifiedCount = values
    ? (allIds.filter((id) => IE_SETTINGS_SCHEMA[id].tier === 'popup' && !isDefault(id, values[id])).length)
    : 0;

  const onChange = async (id: IESettingId, value: unknown) => {
    await setIESetting(plugin, id, value as never);
  };

  const visibleGroups = IE_SETTING_IDS_BY_GROUP.filter((g) => g.ids.some(matches));
  const shownGroups = query ? visibleGroups : visibleGroups.filter((g) => g.group === activeGroup);

  const navBtn = (active: boolean): CSSProperties => ({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    textAlign: 'left',
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    padding: '7px 10px',
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    color: active ? 'var(--rn-clr-content-primary, #0f172a)' : 'var(--rn-clr-content-secondary, #475569)',
    backgroundColor: active ? 'var(--rn-clr-background-tertiary, #f1f5f9)' : 'transparent',
  });

  return (
    <div
      className="incremental-everything-element"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        boxSizing: 'border-box',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: 'var(--rn-clr-content-primary, #0f172a)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 16px',
          borderBottom: '1px solid var(--rn-clr-background-tertiary, #f1f5f9)',
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 700 }}>Incremental Everything — Settings</span>
        <span style={{ fontSize: 11, color: 'var(--rn-clr-content-tertiary, #94a3b8)' }}>
          {modifiedCount} changed from default
        </span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search settings…"
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            padding: '5px 10px',
            width: 220,
            border: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
            borderRadius: 6,
            backgroundColor: 'var(--rn-clr-background-primary, #fff)',
            color: 'var(--rn-clr-content-primary, #0f172a)',
          }}
        />
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {!query && (
          <div
            style={{
              width: 210,
              flexShrink: 0,
              padding: '10px 8px',
              borderRight: '1px solid var(--rn-clr-background-tertiary, #f1f5f9)',
              overflowY: 'auto',
            }}
          >
            {IE_SETTING_IDS_BY_GROUP.map(({ group, ids }) => (
              <button key={group} onClick={() => setActiveGroup(group)} style={navBtn(group === activeGroup)}>
                <span>{IE_SETTING_GROUPS[group].label}</span>
                <span style={{ fontSize: 10, color: 'var(--rn-clr-content-tertiary, #94a3b8)' }}>
                  {ids.filter(visible).length}
                </span>
              </button>
            ))}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 18px 24px' }}>
          {!values ? (
            <div style={{ fontSize: 12, color: 'var(--rn-clr-content-tertiary, #94a3b8)', padding: '20px 0' }}>
              Loading settings…
            </div>
          ) : shownGroups.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--rn-clr-content-tertiary, #94a3b8)', padding: '20px 0' }}>
              No settings match “{search}”.
            </div>
          ) : (
            shownGroups.map(({ group, ids }) => (
              <div key={group} style={{ marginBottom: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{IE_SETTING_GROUPS[group].label}</span>
                  {IE_SETTING_GROUPS[group].helpPath && (
                    <HelpLink
                      path={IE_SETTING_GROUPS[group].helpPath!}
                      label={IE_SETTING_GROUPS[group].label}
                    />
                  )}
                </div>
                {IE_SETTING_GROUPS[group].blurb && (
                  <div
                    style={{
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: 'var(--rn-clr-content-tertiary, #94a3b8)',
                      marginTop: 2,
                    }}
                  >
                    {IE_SETTING_GROUPS[group].blurb}
                  </div>
                )}
                {ids.filter(matches).map((id) => (
                  <SettingRow
                    key={id}
                    id={id}
                    spec={IE_SETTINGS_SCHEMA[id]}
                    value={values[id]}
                    onChange={(v) => onChange(id, v)}
                    hiddenDependents={hiddenDependentsOf(id, values)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

renderWidget(IESettingsWidget);
