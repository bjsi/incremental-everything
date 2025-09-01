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
  initOnlyShowReader: true,
};

export function Reader(props: ReaderProps) {
  const { actionItem } = props;
  const plugin = usePlugin();
  const hasScrolled = React.useRef(false);

  React.useEffect(() => {
    const isHighlight =
      actionItem.type === 'pdf-highlight' || actionItem.type === 'html-highlight';

    if (isHighlight && !hasScrolled.current) {
      actionItem.extract.scrollToReaderHighlight();
      hasScrolled.current = true;
    }

    const extractId = isHighlight ? actionItem.extract._id : null;
    plugin.storage.setSession(activeHighlightIdKey, extractId);

    return () => {
      plugin.storage.setSession(activeHighlightIdKey, null);
    };
  }, [actionItem, plugin]);

  return <PDFWebReader remId={actionItem.rem._id} {...sharedProps} />;
}