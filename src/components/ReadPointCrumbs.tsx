import React from 'react';
import { RNPlugin } from '@remnote/plugin-sdk';
import type { ReadPointPath } from '../lib/remReadPoint';
import { openAndFocusRem } from '../lib/remHelpers';

/** Characters kept per path segment before it is cut with an ellipsis. */
const DEFAULT_SEGMENT_CHARS = 28;

/**
 * The path from an outline IncRem down to its read point, one clickable
 * segment per Rem. The IncRem itself is implicit — whoever renders this is
 * attached to it. The last segment (the bookmarked Rem) is bold and blue.
 *
 * Shared by the Priority Editor's Read Point panel and the read-point row of
 * the counter under a document's title.
 */
export function ReadPointCrumbs({
  plugin,
  readPoint,
  segmentChars = DEFAULT_SEGMENT_CHARS,
  className,
  style,
}: {
  plugin: RNPlugin;
  readPoint: ReadPointPath;
  segmentChars?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span className={className} style={style}>
      {readPoint.path.map((segment, i) => {
        const isLast = i === readPoint.path.length - 1;
        const id = readPoint.pathIds[i];
        return (
          <span key={id || i}>
            {i > 0 && <span style={{ opacity: 0.6, margin: '0 3px' }}>›</span>}
            <span
              onClick={() => { if (id) openAndFocusRem(plugin, id); }}
              title={`${segment}\n\nClick to open this rem`}
              style={{
                cursor: 'pointer',
                fontWeight: isLast ? 600 : 400,
                color: isLast ? 'var(--rn-clr-blue, #3b82f6)' : 'inherit',
                textDecoration: 'underline',
                textDecorationStyle: 'dotted',
              }}
            >
              {segment.length > segmentChars ? segment.slice(0, segmentChars) + '…' : segment}
            </span>
          </span>
        );
      })}
    </span>
  );
}
