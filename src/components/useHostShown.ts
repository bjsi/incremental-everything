import { useEffect, useState } from 'react';

/**
 * Whether the host is showing this widget's iframe. RemNote gives a widget no
 * way to ask which queue variant is active, but QUEUE_VARIANT_CSS (in
 * register/widgets.ts) hides the queue widgets that do not belong to the current
 * variant with display: none, and a hidden iframe's window reports a zero width.
 * Switching variants toggles that and fires a resize.
 */
export function useHostShown() {
  const [shown, setShown] = useState(() => window.innerWidth > 0);
  useEffect(() => {
    const onResize = () => setShown(window.innerWidth > 0);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return shown;
}
