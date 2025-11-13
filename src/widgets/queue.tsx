import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React, { useEffect, useRef } from 'react';
import { Reader } from '../components/Reader';
import { VideoViewer } from '../components/Video';
import { NativeVideoViewer } from '../components/NativeVideoViewer';
import { ExtractViewer } from '../components/ExtractViewer';
import { remToActionItemType } from '../lib/incremental_rem';
import {
  collapseQueueTopBar,
  collapseTopBarKey,
  incrementalQueueActiveKey,
  shouldHideIncEverythingKey,
  currentIncrementalRemTypeKey,
  activeHighlightIdKey,
} from '../lib/consts';
import { setCurrentIncrementalRem } from '../lib/incremental_rem';

console.log('QUEUE.TSX FILE LOADED');

export function QueueComponent() {
  const plugin = usePlugin();

  console.log('🎬 QueueComponent RENDER START');

  const ctx = useRunAsync(
    async () => {
      console.log('🎬 ctx: Getting widget context...');
      const context = await plugin.widget.getWidgetContext<WidgetLocation.Flashcard>();
      console.log('🎬 ctx: Got context:', context);
      return context;
    },
    []
  );

  console.log('🎬 QueueComponent ctx value:', ctx);

  // MOVE ALL HOOKS HERE - BEFORE ANY RETURNS
  const remAndType = useTrackerPlugin(
    async (rp) => {
      // Add guard INSIDE the hook
      if (!ctx?.remId) {
        console.log('⛔ useTrackerPlugin: No ctx.remId yet');
        return undefined;
      }
      
      console.log('🔄 useTrackerPlugin RUNNING for remId:', ctx.remId);
      const rem = await rp.rem.findOne(ctx.remId);
      if (!rem) {
        console.log('⛔ useTrackerPlugin: Rem not found');
        return null;
      }
      
      console.log('🔄 useTrackerPlugin: Calling remToActionItemType');
      const result = await remToActionItemType(rp, rem);
      console.log('✅ useTrackerPlugin result:', result?.type);
      return result;
    },
    [ctx?.remId]
  );

  const lastProcessedRemId = useRef<string | null>(null);
  
  useEffect(() => {
    if (ctx?.remId && ctx.remId !== lastProcessedRemId.current) {
      lastProcessedRemId.current = ctx.remId;
      console.log('🔄 Processing new rem in queue:', ctx.remId);
    }
  }, [ctx?.remId]);

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
  
  // AFTER ALL HOOKS, NOW you can return early
  if (!ctx?.remId) {
    console.log('⛔ QueueComponent: No ctx.remId, returning null');
    return null;
  }

  console.log('🎬 QueueComponent: ctx.remId exists:', ctx.remId);


  if (remAndType?.type === 'rem' && !shouldRenderEditorForRemType) {
    return null;
  }

  console.log('🎬 QueueComponent FINAL RENDER:', {
    remId: ctx?.remId,
    type: remAndType?.type,
    willRender: remAndType ? 'YES' : 'NO'
  });

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
        ) : remAndType.type === 'video' ? (
          <NativeVideoViewer actionItem={remAndType} />
        ) : remAndType.type === 'rem' ? (
          <ExtractViewer rem={remAndType.rem} plugin={plugin} />
        ) : null}
      </div>
    </div>
  );
}

renderWidget(QueueComponent);

