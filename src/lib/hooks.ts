import { usePlugin, useTracker } from '@remnote/plugin-sdk';
import React from 'react';
import { useEffect, useRef } from 'react';
import { collapseQueueTopBar as collapseQueueTopBarId, collapseTopBarKey } from './consts';

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
  console.log('useQueueCSS');
  const shouldCollapse = useTracker(
    () => plugin.settings.getSetting<boolean>(collapseQueueTopBarId),
    []
  );
  
  React.useEffect(() => {
    plugin.storage.setSession(collapseTopBarKey, shouldCollapse);
    
    return () => {
      plugin.storage.setSession(collapseTopBarKey, false);
    };
  }, [shouldCollapse]);
};
