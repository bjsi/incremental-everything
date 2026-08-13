import React from 'react';
import { usePlugin, useRunAsync } from '@remnote/plugin-sdk';
import { resolveRemTextSegments, RemTextSegment } from '../lib/richTextRemRefs';

/**
 * Renders pre-resolved rem-text segments as plain spans:
 *  - text segments      → plain text (references already wrapped in `[ ]`)
 *  - pin segments       → a 📌 icon whose hover tooltip is the referenced text
 *  - clozed text        → wrapped in `{{ }}` when `markClozes` is set
 *
 * Synchronous and embed-free, so it is cheap even in long lists.
 */
export function RemTextSegments({
  segments,
  className,
  markClozes,
}: {
  segments: RemTextSegment[];
  className?: string;
  /**
   * Wrap clozed spans in `{{ }}` — the same convention the preserve-history
   * card names use. Off by default: most lists show a rem, not a card, and the
   * braces would be noise there.
   */
  markClozes?: boolean;
}) {
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.kind === 'pin' ? (
          <span key={i} title={seg.text} style={{ cursor: 'help', opacity: 0.7 }}>
            📌
          </span>
        ) : markClozes && seg.cId ? (
          <span key={i} title="Cloze">
            <span style={{ opacity: 0.5 }}>{'{{'}</span>
            {seg.text}
            <span style={{ opacity: 0.5 }}>{'}}'}</span>
          </span>
        ) : (
          <React.Fragment key={i}>{seg.text}</React.Fragment>
        )
      )}
    </span>
  );
}

interface RemTextProps {
  /** Rem whose text to render. Provide this or `text`. */
  remId?: string;
  /** Raw rich text, when already loaded — avoids an extra rem lookup. */
  text?: unknown;
  className?: string;
  /** Wrap clozed spans in `{{ }}`. See {@link RemTextSegments}. */
  markClozes?: boolean;
}

/**
 * Lightweight renderer for a rem's text. Resolves rem references asynchronously
 * (normal references → `[ ]`-wrapped text, pins → tooltip icon) then renders
 * plain spans. Use {@link RemTextSegments} directly when segments are already
 * resolved upstream.
 */
export function RemText({ remId, text, className, markClozes }: RemTextProps) {
  const plugin = usePlugin();

  const segments = useRunAsync(async () => {
    let rt: unknown = text;
    if (rt === undefined && remId) {
      const rem = await plugin.rem.findOne(remId);
      rt = rem?.text ?? null;
    }
    if (rt == null) return null;
    return resolveRemTextSegments(plugin, rt);
  }, [remId, text]);

  if (segments === undefined) {
    return <span className={className}>Loading...</span>;
  }
  if (!segments || segments.length === 0) {
    return <span className={className}>[Empty rem]</span>;
  }

  return <RemTextSegments segments={segments} className={className} markClozes={markClozes} />;
}
