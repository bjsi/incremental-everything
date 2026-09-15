import { renderWidget } from '@remnote/plugin-sdk';
import { QueuePriorityBadge } from '../components/QueuePriorityBadge';
import { useHostShown } from '../components/useHostShown';

// Compact queue only: QUEUE_VARIANT_CSS hides it in the Beautiful chrome, where
// queue_beautiful_bar carries this badge instead.
function QueueToolbarPriority() {
  const shown = useHostShown();
  return <QueuePriorityBadge active={shown} />;
}

renderWidget(QueueToolbarPriority);
