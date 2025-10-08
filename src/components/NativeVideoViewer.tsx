import { DocumentViewer } from '@remnote/plugin-sdk';
import React from 'react';

interface NativeVideoViewerProps {
  actionItem: {
    rem: any;
    type: string;
  };
}

export const NativeVideoViewer: React.FC<NativeVideoViewerProps> = (props) => {
  return (
    <div className="flex h-[100%] video-container w-[100%]">
      <DocumentViewer 
        width={'100%'} 
        height={'100%'} 
        documentId={props.actionItem.rem._id} 
      />
    </div>
  );
};