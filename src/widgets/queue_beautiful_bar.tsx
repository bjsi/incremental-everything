import { renderWidget } from '@remnote/plugin-sdk';
import { QueuePriorityBadge } from '../components/QueuePriorityBadge';
import { NoIncTimerIndicator } from '../components/NoIncTimerIndicator';
import { useHostShown } from '../components/useHostShown';

// Beautiful queue variant only (QUEUE_VARIANT_CSS hides it in Compact): carries
// the toolbar badge and timer at QueueBelowTopBar — one iframe instead of two.
// The Beautiful chrome's own QueueToolbar slot is hidden for these, as they look
// out of place there. The CSS floats this into the card box's blank top-right
// corner; the 24px right padding plus the badge's own 8px margin lines it up
// with the card content's 32px (px-8) edge.
function QueueBeautifulBar() {
  const shown = useHostShown();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: '8px',
        padding: '0 24px 0 12px',
      }}
    >
      <NoIncTimerIndicator active={shown} />
      <QueuePriorityBadge active={shown} />
    </div>
  );
}

renderWidget(QueueBeautifulBar);
