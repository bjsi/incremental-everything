import { renderWidget, usePlugin, useRunAsync, WidgetLocation } from '@remnote/plugin-sdk';
import React from 'react';
import '../style.css';
import '../App.css';
import { withHoverTips } from '../components/HoverTipLayer';
import { LocalVideoViewer } from '../components/LocalVideoViewer';
import { cardVideoItemForRem } from '../lib/local_video';

// The video that explains a flashcard (Link Local Video as Card Extra), under
// its answer. RemNote mounts the FlashcardExtraDetail slot only once the answer
// is revealed (on a list card, at its last step), where Extra Card Details
// show, and only for a card whose Rem has the Card Video powerup (the widget's
// powerupFilter). So there is no reveal to listen for: being here means it.
// The slot goes away when the next card loads, and this with it.

function CardVideo() {
  const plugin = usePlugin();
  const item = useRunAsync(async () => {
    const ctx = await plugin.widget.getWidgetContext<WidgetLocation.FlashcardExtraDetail>();
    const rem = ctx?.remId ? await plugin.rem.findOne(ctx.remId) : undefined;
    return rem ? await cardVideoItemForRem(rem) : null;
  }, []);

  if (!item) return null;
  return (
    <div style={{ padding: '4px 0 8px' }}>
      <LocalVideoViewer key={item.rem._id} actionItem={item} cardExtra autoplay={false} />
    </div>
  );
}

renderWidget(withHoverTips(CardVideo));
