import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
  WidgetLocation,
  BuiltInPowerupCodes,
} from '@remnote/plugin-sdk';

function VideoDebug() {
  const plugin = usePlugin();
  
  const ctx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.Popup>(),
    []
  );
  
  const remId = ctx?.contextData?.remId;
  
  const debugInfo = useTrackerPlugin(
    async (rp) => {
      if (!remId) return null;
      
      const rem = await rp.rem.findOne(remId);
      if (!rem) return null;

      const info = {
        remId: rem._id,
        hasVideoPowerup: await rem.hasPowerup('vi'),
        hasLinkPowerup: await rem.hasPowerup(BuiltInPowerupCodes.Link),
        text: await rp.richText.toString(rem.text || []),
        childrenCount: 0,
      };
      // getChildrenRem, not the lazy `children` field, which is empty for Rems
      // whose document has not been loaded (priority_review_document/children.ts).
      const remChildren = (await rem.getChildrenRem().catch(() => [])) || [];
      info.childrenCount = remChildren.length;

      let urlSearchResults: any = {};
      
      // Check ALL children
      if (remChildren.length > 0) {
        const children = remChildren;
        urlSearchResults.children = [];
        
        for (const child of children || []) {
          const childInfo: any = {
            id: child._id,
            text: await rp.richText.toString(child.text || []),
            hasLink: await child.hasPowerup(BuiltInPowerupCodes.Link),
          };
          
          // If child has Link, try to get URL
          if (childInfo.hasLink) {
            try {
              childInfo.url = await child.getPowerupProperty(
                BuiltInPowerupCodes.Link,
                'URL'
              );
            } catch (e) {}
          }
          
          // Check if text contains a URL pattern
          const urlMatch = childInfo.text.match(/(https?:\/\/[^\s]+)/);
          if (urlMatch) {
            childInfo.extractedUrl = urlMatch[0];
          }
          
          urlSearchResults.children.push(childInfo);
        }
      }

      return { ...info, urlSearchResults };
    },
    [remId]
  );

  if (!debugInfo) {
    return <div className="p-4">Loading or no rem selected...</div>;
  }

  return (
    <div className="p-4 space-y-2 font-mono text-xs">
      <h2 className="font-bold text-lg mb-4">🎥 Video Powerup Debug</h2>
      
      <div><strong>Rem ID:</strong> {debugInfo.remId}</div>
      <div><strong>Text:</strong> {debugInfo.text}</div>
      
      <div className="mt-4">
        <strong>Powerups:</strong>
        <div className="ml-4">
          <div>Video ('vi'): {debugInfo.hasVideoPowerup ? '✅ YES' : '❌ NO'}</div>
          <div>Link: {debugInfo.hasLinkPowerup ? '✅ YES' : '❌ NO'}</div>
        </div>
      </div>

      <div className="mt-4">
        <strong>Children:</strong> {debugInfo.childrenCount}
      </div>

      <div className="mt-4">
        <strong>URL Search Results:</strong>
        <pre className="ml-4 bg-gray-50 p-2 rounded text-[10px] overflow-auto max-h-96">
          {JSON.stringify(debugInfo.urlSearchResults, null, 2)}
        </pre>
      </div>
    </div>
  );
}

renderWidget(VideoDebug);