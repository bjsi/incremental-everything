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
  const plugin = usePlugin();

  React.useEffect(() => {
    plugin.app.registerCSS(
      'reader',
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
