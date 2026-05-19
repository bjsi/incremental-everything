import React from 'react';
import { usePlugin, useRunAsync } from '@remnote/plugin-sdk';
import { resolveRemTextSegments } from '../lib/richTextRemRefs';

interface RemTextProps {
  /** Rem whose text to render. Provide this or `text`. */
  remId?: string;
  /** Raw rich text, when already loaded — avoids an extra rem lookup. */
  text?: unknown;
  className?: string;
}

/**
 * Lightweight renderer for a rem's text:
 *  - normal rem references → their text wrapped in `[ ]` markers
 *  - pin references         → a 📌 icon whose hover tooltip is the referenced text
 *
 * Renders plain spans only (no SDK embed), so it is cheap in long lists.
 */
export function RemText({ remId, text, className }: RemTextProps) {
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

  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.kind === 'pin' ? (
          <span key={i} title={seg.text} style={{ cursor: 'help', opacity: 0.7 }}>
            📌
          </span>
        ) : (
          <React.Fragment key={i}>{seg.text}</React.Fragment>
        )
      )}
    </span>
  );
}
