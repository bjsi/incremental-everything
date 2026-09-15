import { renderWidget } from '@remnote/plugin-sdk';
import { NoIncTimerIndicator } from '../components/NoIncTimerIndicator';
import { useHostShown } from '../components/useHostShown';

// Compact queue only: QUEUE_VARIANT_CSS hides it in the Beautiful chrome, where
// queue_beautiful_bar carries this indicator instead.
function NoIncTimerIndicatorWidget() {
  const shown = useHostShown();
  return <NoIncTimerIndicator active={shown} />;
}

renderWidget(NoIncTimerIndicatorWidget);
