import { renderWidget } from '@remnote/plugin-sdk';
import { useEffect, useState } from 'react';
import { QueuePriorityBadge } from '../components/QueuePriorityBadge';
import { NoIncTimerIndicator } from '../components/NoIncTimerIndicator';

/**
 * Whether the host is showing this iframe. RemNote gives a widget no way to ask
 * which queue variant is active, but QUEUE_BEAUTIFUL_BAR_CSS hides this iframe
 * (display: none) outside the Beautiful queue, and a hidden iframe's window
 * reports a zero width. Switching variants toggles that and fires a resize.
 */
function useHostShown() {
  const [shown, setShown] = useState(() => window.innerWidth > 0);
  useEffect(() => {
    const onResize = () => setShown(window.innerWidth > 0);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return shown;
}

// The Beautiful queue variant renders no QueueToolbar location, so the two
// toolbar widgets never mount there. QueueBelowTopBar is still rendered (at the
// top of the card box), so this widget carries both — one iframe instead of two.
// QUEUE_BEAUTIFUL_BAR_CSS floats it into the box's blank top-right corner; the
// 24px right padding plus the badge's own 8px margin lines it up with the card
// content's 32px (px-8) edge.
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
