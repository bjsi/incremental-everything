import { renderWidget } from '@remnote/plugin-sdk';
import { NoIncTimerIndicator } from '../components/NoIncTimerIndicator';

// Compact queue only: the Beautiful variant does not render the QueueToolbar
// location at all — queue_beautiful_bar carries this indicator there.
function NoIncTimerIndicatorWidget() {
  return <NoIncTimerIndicator />;
}

renderWidget(NoIncTimerIndicatorWidget);
