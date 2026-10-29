import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { QueuePriorityBadge } from '../components/QueuePriorityBadge';
import { NoIncTimerIndicator } from '../components/NoIncTimerIndicator';
import { useHostShown } from '../components/useHostShown';
import { reportQueueBeautifulBarWidth } from '../lib/queue_beautiful_bar_fit';

// Beautiful queue variant only (QUEUE_VARIANT_CSS hides it in Compact): carries
// the toolbar badge and timer at QueueBelowTopBar — one iframe instead of two.
// The Beautiful chrome's own QueueToolbar slot is hidden for these, as they look
// out of place there. The CSS floats this into the card box's blank top-right
// corner; the 24px right padding plus the badge's own 8px margin lines it up
// with the card content's 32px (px-8) edge.
//
// The strip is sized to this content (lib/queue_beautiful_bar_fit), so it is
// measured at max-content: its width then never depends on the strip's own,
// which would feed back on itself.
function QueueBeautifulBar() {
  const plugin = usePlugin();
  const shown = useHostShown();
  const observerRef = React.useRef<ResizeObserver | null>(null);
  const contentRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!el) return;
      const observer = new ResizeObserver(() => {
        // 0 while the host hides the iframe (Compact): nothing to size then.
        if (el.offsetWidth > 0) void reportQueueBeautifulBarWidth(plugin, el.offsetWidth);
      });
      observer.observe(el);
      observerRef.current = observer;
    },
    [plugin]
  );
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div
        ref={contentRef}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '0 24px 0 12px',
          width: 'max-content',
          flexShrink: 0,
        }}
      >
        <NoIncTimerIndicator active={shown} />
        <QueuePriorityBadge active={shown} />
      </div>
    </div>
  );
}

renderWidget(QueueBeautifulBar);
