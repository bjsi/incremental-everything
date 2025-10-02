import {
  DocumentViewer,
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React, { useEffect, useRef } from 'react';
import { Reader } from '../components/Reader';
import { VideoViewer } from '../components/Video';
import { ExtractViewer } from '../components/ExtractViewer';
import { remToActionItemType } from '../lib/actionItems';
import {
  collapseQueueTopBar,
  collapseTopBarKey,
  incrementalQueueActiveKey,
  shouldHideIncEverythingKey,
  currentIncrementalRemTypeKey,
  activeHighlightIdKey,
} from '../lib/consts';
import { setCurrentIncrementalRem } from '../lib/currentRem';

export function QueueComponent() {
  const plugin = usePlugin();

  const ctx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.Flashcard>(),
    []
  );

  const remAndType = useTrackerPlugin(
    async (rp) => {
      if (!ctx) return undefined;
      const rem = await rp.rem.findOne(ctx?.remId);
      if (!rem) return null;
      return await remToActionItemType(rp, rem);
    },
    [ctx?.remId]
  );

  const shouldCollapseTopBar = useTrackerPlugin(
    (rp) => rp.settings.getSetting<boolean>(collapseQueueTopBar),
    []
  );

  // This hook signals the component's state and manages the top bar.
  useEffect(() => {
    plugin.storage.setSession(incrementalQueueActiveKey, true);
    plugin.storage.setSession(collapseTopBarKey, shouldCollapseTopBar);
    return () => {
      plugin.storage.setSession(incrementalQueueActiveKey, false);
      plugin.storage.setSession(collapseTopBarKey, false);
    };
  }, [plugin, shouldCollapseTopBar]);

  useEffect(() => {
    // The true identity of the incremental item in the queue is ALWAYS ctx.remId.
    // remAndType tells us WHAT to display, but ctx.remId tells us WHO we are.
    const incrementalRemId = ctx?.remId;
    setCurrentIncrementalRem(plugin, incrementalRemId);
    
    plugin.storage.setSession(currentIncrementalRemTypeKey, remAndType?.type);
    
    // For highlights, we still need to identify the specific extract.
    const activeHighlight = (remAndType?.type === 'pdf-highlight' || remAndType?.type === 'html-highlight') 
      ? (remAndType as any).extract?._id 
      : null;
    plugin.storage.setSession(activeHighlightIdKey, activeHighlight);

    if (remAndType === null) {
      plugin.queue.removeCurrentCardFromQueue(false);
    }
  }, [ctx?.remId, remAndType, plugin]);

  const shouldRenderEditorForRemType = useRunAsync(async () => {
    if (remAndType?.type !== 'rem') {
      return false;
    }
    const widgetsAtLocation = (
      await plugin.widget.getWidgetsAtLocation(WidgetLocation.Flashcard, remAndType.rem._id)
    ).filter((w) => w.pluginId !== 'incremental-everything');
    return widgetsAtLocation.length === 0;
  }, [remAndType?.type, remAndType?.rem?._id, plugin]);

  useEffect(() => {
    const shouldHide = remAndType?.type === 'rem' && !shouldRenderEditorForRemType;
    plugin.storage.setSession(shouldHideIncEverythingKey, shouldHide);
    return () => {
      plugin.storage.setSession(shouldHideIncEverythingKey, false);
    };
  }, [remAndType?.type, shouldRenderEditorForRemType, plugin]);
  
  if (remAndType?.type === 'rem' && !shouldRenderEditorForRemType) {
    return null;
  }

  return (
    <div className="incremental-everything-element" style={{ height: '100%' }}>
      <div className="box-border p-2" style={{ height: `100vh` }}>
        {!remAndType ? null : remAndType.type === 'pdf' ||
          remAndType.type === 'html' ||
          remAndType.type === 'pdf-highlight' ||
          remAndType.type === 'html-highlight' ? (
          <Reader actionItem={remAndType} />
        ) : remAndType.type === 'youtube' ? (
          <VideoViewer actionItem={remAndType} />
        ) : remAndType.type === 'rem' ? (
          <ExtractViewer rem={remAndType.rem} plugin={plugin} />
        ) : null}
      </div>
    </div>
  );
}

renderWidget(QueueComponent);


