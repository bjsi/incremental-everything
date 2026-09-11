import { renderWidget } from '@remnote/plugin-sdk';
import { QueuePriorityBadge } from '../components/QueuePriorityBadge';

// Compact queue only: the Beautiful variant does not render the QueueToolbar
// location at all — queue_beautiful_bar carries this badge there.
function QueueToolbarPriority() {
  return <QueuePriorityBadge />;
}

renderWidget(QueueToolbarPriority);
