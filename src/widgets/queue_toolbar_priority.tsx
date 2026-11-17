import { renderWidget, useTrackerPlugin } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React from 'react';
import { QueuePriorityBadge } from '../components/QueuePriorityBadge';
import { NoIncTimerIndicator } from '../components/NoIncTimerIndicator';
import { isMobileDevice } from '../lib/mobileUtils';

/**
 * The queue's toolbar widget: the "No Inc Rem" countdown and the current item's
 * priority badge, in one iframe at QueueToolbar, in both queue variants. RemNote puts
 * QueueToolbar widgets in the Compact queue's top bar and, since 1.30, in the
 * Beautiful queue's top-right actions on a computer.
 *
 * On a phone the Beautiful queue mounts no QueueToolbar widgets at all (read in the
 * 1.30.4 bundle), and the Compact top bar is short of room: there the badge is left
 * out for Incremental Rems, whose answer bar already shows their priority.
 */
function QueueToolbar() {
  const phone =
    useTrackerPlugin(
      async (rp) =>
        (await isMobileDevice(rp)) &&
        Math.min(window.screen?.width || 9999, window.screen?.height || 9999) < 600,
      []
    ) ?? false;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <NoIncTimerIndicator />
      <QueuePriorityBadge hideIncRem={phone} />
    </div>
  );
}

renderWidget(withHoverTips(QueueToolbar));
