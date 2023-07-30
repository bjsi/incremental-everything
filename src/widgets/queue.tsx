import {
  BuiltInPowerupCodes,
  PDFWebReader,
  Rem,
  RemHierarchyEditorTree,
  RemRichTextEditor,
  renderWidget,
  RNPlugin,
  usePlugin,
  useRunAsync,
  useTracker,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React from 'react';
import { Reader } from '../components/Reader';
import { VideoViewer } from '../components/Video';
import { remToActionItemType } from '../lib/actionItems';
import { useQueueCSS } from '../lib/hooks';

export function QueueComponent() {
  const plugin = usePlugin();
  useQueueCSS();
  const ctx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.Flashcard>(),
    []
  );
  const remAndType = useTracker(
    async (rp) => {
      const rem = await rp.rem.findOne(ctx?.remId);
      if (!rem) {
        return undefined;
      }
      const ret = await remToActionItemType(plugin, rem);
      console.log('remAndType', ret);
      return ret;
    },
    [ctx?.remId]
  );

  React.useEffect(() => {
    if (remAndType === null) {
      plugin.queue.removeCurrentCardFromQueue(false);
    }
  }, [remAndType]);

  /**
   * If the rem is a rem type, then we should render the rem editor
   * if there are no other plugin widgets at this location
   */
  const shouldRenderEditorForRemType = useRunAsync(async () => {
    if (remAndType?.type !== 'rem') {
      return false;
    } else {
      const widgetsAtLocation = (
        await plugin.widget.getWidgetsAtLocation(WidgetLocation.Flashcard, remAndType.rem._id)
      ).filter((w) => w.pluginId !== 'incremental-everything');
      return widgetsAtLocation.length === 0;
    }
  }, [remAndType?.type, remAndType?.rem._id]);

  return (
    <div
      style={{
        height: '100%',
      }}
    >
      <div
        className="box-border p-2"
        style={{
          height: `100%`,
        }}
      >
        {!remAndType ? null : remAndType.type === 'pdf' ||
          remAndType.type === 'html' ||
          remAndType.type === 'pdf-highlight' ||
          remAndType.type === 'html-highlight' ? (
          <Reader actionItem={remAndType} />
        ) : remAndType.type === 'youtube' ? (
          <VideoViewer rem={remAndType.rem} />
        ) : remAndType.type === 'rem' && shouldRenderEditorForRemType ? (
          <div className="flex flex-col gap-2">
            <RemRichTextEditor remId={remAndType.rem._id} width={'100%'} />
            <RemHierarchyEditorTree
              width={'100%'}
              height={`calc(100%)`}
              maxHeight={`calc(100%)`}
              remId={remAndType.rem._id}
            ></RemHierarchyEditorTree>
          </div>
        ) : null}
      </div>
    </div>
  );
}

renderWidget(QueueComponent);
