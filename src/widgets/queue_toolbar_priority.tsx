import { renderWidget, useTrackerPlugin } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React, { useEffect } from 'react';
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
/**
 * The page is see-through. Left alone, the iframe showed as a white box on the
 * Beautiful queue's dark chrome (in RemNote's light theme): the frame's canvas, not
 * any background of ours or RemNote's. A browser paints an opaque backdrop behind an
 * iframe whose page's colour scheme differs from the one its host element uses
 * (tested in Chrome: a light page in a dark host element shows white, a dark page in
 * a light one black). So both sides are pinned to `light`: the page's root here, the
 * iframe element by host CSS (TOOLBAR_FRAME_CSS in register/widgets.ts). The badge
 * and the countdown set their own colours, so the scheme does not change how they look.
 */
function useTransparentFrame() {
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent =
      'html { color-scheme: light !important; } html, body { background: transparent !important; margin: 0; }';
    document.head.appendChild(style);
    return () => style.remove();
  }, []);
}

function QueueToolbar() {
  useTransparentFrame();
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
