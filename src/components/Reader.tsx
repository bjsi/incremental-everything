import { PDFWebReader, PluginCommandMenuLocation, usePlugin } from '@remnote/plugin-sdk';
import plugin from 'dayjs/plugin/relativeTime';
import React from 'react';
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
  /**
   * Scroll to the highlight in the PDF/HTML reader
   */
  React.useEffect(() => {
    if (actionItem.type === 'pdf-highlight' || actionItem.type === 'html-highlight') {
      actionItem.extract.scrollToReaderHighlight();

      // register a menu item to scroll to the highlight
      plugin.app.registerMenuItem({
        id: 'scroll-to-highlight',
        name: 'Scroll to Highlight',
        location: PluginCommandMenuLocation.ReaderMenu,
        action: async () => {
          actionItem.extract.scrollToReaderHighlight();
        },
      });
    }
    return () => {
      plugin.app.unregisterMenuItem('scroll-to-highlight');
    };
  }, [actionItem]);

  return <PDFWebReader remId={actionItem.rem._id} {...sharedProps} />;
}
