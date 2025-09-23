// components/Reader.tsx
import {
  PDFWebReader,
  usePlugin,
} from '@remnote/plugin-sdk';
import React from 'react';
import { activeHighlightIdKey } from '../lib/consts';
import {
  HTMLActionItem,
  HTMLHighlightActionItem,
  PDFActionItem,
  PDFHighlightActionItem,
} from '../lib/types';

interface ReaderProps {
  actionItem: PDFActionItem | PDFHighlightActionItem | HTMLActionItem | HTMLHighlightActionItem;
}

const sharedProps = {
  height: '100%',
  width: '100%',
  initOnlyShowReader: false,
  // Force maximum dimensions to ensure full interface
  maxHeight: '100%',
  maxWidth: '100%',
};

export function Reader(props: ReaderProps) {
  const { actionItem } = props;
  const plugin = usePlugin();
  const hasScrolled = React.useRef(false);
  const [isReaderReady, setIsReaderReady] = React.useState(false);

  React.useEffect(() => {
    const isHighlight =
      actionItem.type === 'pdf-highlight' || actionItem.type === 'html-highlight';

    if (isHighlight && !hasScrolled.current && isReaderReady) {
      // Add small delay to ensure PDF is fully loaded
      setTimeout(() => {
        actionItem.extract.scrollToReaderHighlight();
        hasScrolled.current = true;
      }, 100);
    }

    const extractId = isHighlight ? actionItem.extract._id : null;
    plugin.storage.setSession(activeHighlightIdKey, extractId);

    return () => {
      plugin.storage.setSession(activeHighlightIdKey, null);
    };
  }, [actionItem, plugin]);

  // Effect to ensure reader is properly initialized
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setIsReaderReady(true);
    }, 200); // Give PDF reader time to initialize

    return () => clearTimeout(timer);
  }, [actionItem.rem._id]);

  // Reset ready state when switching documents
  React.useEffect(() => {
    setIsReaderReady(false);
    hasScrolled.current = false;
  }, [actionItem.rem._id]);

  return (
    <PDFWebReader 
      remId={actionItem.rem._id} 
      {...sharedProps}
      key={actionItem.rem._id} // Force re-render when switching documents
    />
  );
}