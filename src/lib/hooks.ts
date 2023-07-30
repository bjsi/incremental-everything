import { usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { useEffect, useRef } from 'react';

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

export const useQueueCSS = () => {
  const plugin = usePlugin();
  React.useEffect(() => {
    plugin.app.registerCSS(
      'incremental-everything-queue',
      `
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
}
`.trim()
    );
    return () => void plugin.app.registerCSS('reader', '');
  }, []);
};
