import { PDFWebReader, usePlugin } from '@remnote/plugin-sdk';
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
  /**
   * Scroll to the highlight in the PDF/HTML reader
   */
  React.useEffect(() => {
    if (actionItem.type === 'pdf-highlight' || actionItem.type === 'html-highlight') {
      actionItem.extract.scrollToReaderHighlight();
    }
  }, [actionItem]);

  return <PDFWebReader remId={actionItem.rem._id} {...sharedProps} />;
}
