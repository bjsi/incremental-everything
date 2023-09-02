import { RNPlugin, usePlugin, useTracker } from '@remnote/plugin-sdk';
import React from 'react';
import { useEffect, useRef } from 'react';
import { collapseQueueTopBar as collapseQueueTopBarId, collapseTopBarId } from './consts';

export const unregisterQueueCSS = async (plugin: RNPlugin) => {
  await plugin.app.registerCSS(collapseTopBarId, '');
};

export const useIsMounted = () => {
  const isMounted = useRef(false);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  return isMounted.current;
};

const COLLAPSE_TOP_BAR_CSS = `
.spacedRepetitionContent {
    height: 100%;
    box-sizing: border-box;
}

/* Set initial state to collapsed */
.queue__title {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease;
}

/* Expand on hover */
.queue__title:hover {
  max-height: 999px;
}`.trim();

export const useQueueCSS = () => {
  const plugin = usePlugin();
  console.log('useQueueCSS');
  const shouldCollapse = useTracker(
    () => plugin.settings.getSetting<boolean>(collapseQueueTopBarId),
    []
  );
  React.useEffect(() => {
    if (!shouldCollapse) {
      unregisterQueueCSS(plugin);
    } else {
      plugin.app.registerCSS(collapseTopBarId, COLLAPSE_TOP_BAR_CSS);
    }
    return () => {
      unregisterQueueCSS(plugin);
    };
  }, [shouldCollapse]);
};
