import { PDFWebReader, PluginCommandMenuLocation, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { scrollToHighlightId } from '../lib/consts';
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

  /**
   * Scroll to the highlight in the PDF/HTML reader
   */
  React.useEffect(() => {
    if (
      (actionItem.type === 'pdf-highlight' || actionItem.type === 'html-highlight') &&
      !hasScrolled.current
    ) {
      actionItem.extract.scrollToReaderHighlight();

      // register a menu item to scroll to the highlight
      plugin.app.registerMenuItem({
        id: scrollToHighlightId,
        name: 'Scroll to Highlight',
        location: PluginCommandMenuLocation.ReaderMenu,
        action: async () => {
          actionItem.extract.scrollToReaderHighlight();
        },
      });

      hasScrolled.current = true;
    }
  }, [actionItem]);

  return <PDFWebReader remId={actionItem.rem._id} {...sharedProps} />;
}
