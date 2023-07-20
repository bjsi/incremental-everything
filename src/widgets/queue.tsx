import {
  BuiltInPowerupCodes,
  PDFWebReader,
  Rem,
  RemHierarchyEditorTree,
  RemRichTextEditor,
  renderWidget,
  usePlugin,
  useRunAsync,
  useTracker,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import { VideoViewer } from '../components/video';

export function QueueComponent() {
  const plugin = usePlugin();
  const ctx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.Flashcard>(),
    []
  );
  const remAndType = useTracker(
    async (rp) => {
      const rem = await rp.rem.findOne(ctx?.remId);
      if (rem) {
        if (
          (await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) ||
          (await rem.hasPowerup(BuiltInPowerupCodes.UploadedFile))
        ) {
          return { rem, type: 'pdf' };
        } else if (
          (await rem.hasPowerup(BuiltInPowerupCodes.Link)) &&
          (await rem.getPowerupProperty<BuiltInPowerupCodes.Link>(BuiltInPowerupCodes.Link, 'URL'))
        ) {
          const url = await rem.getPowerupProperty<BuiltInPowerupCodes.Link>(
            BuiltInPowerupCodes.Link,
            'URL'
          );
          if (url.includes('youtube')) {
            return {
              type: 'youtube',
              rem,
            };
          } else {
            return {
              type: 'web',
              rem,
            };
          }
        } else {
          return { rem, type: 'rem' };
        }
      }
    },
    [ctx?.remId]
  );

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
        {(() => {
          if (!remAndType) {
            return null;
          } else if (remAndType.type === 'pdf') {
            return <PDFWebReader remId={remAndType.rem._id} initOnlyShowReader={true} />;
          } else if (remAndType.type === 'web') {
            return (
              <PDFWebReader
                remId={remAndType.rem._id}
                height={'100%'}
                width="100%"
                initOnlyShowReader={true}
              />
            );
          } else if (remAndType.type === 'youtube') {
            return <VideoViewer rem={remAndType.rem} />;
          } else if (remAndType.type === 'rem' && shouldRenderEditorForRemType) {
            // TODO: how to make sure the bottom bar always gets rendered at the bottom if other plugins are also rendering widgets?
            return (
              <div className="flex flex-col gap-2">
                <RemRichTextEditor remId={remAndType.rem._id} width={'100%'} />
                <RemHierarchyEditorTree
                  width={'100%'}
                  height={`calc(100%)`}
                  maxHeight={`calc(100%)`}
                  remId={remAndType.rem._id}
                ></RemHierarchyEditorTree>
              </div>
            );
          }
          return null;
        })()}
      </div>
    </div>
  );
}

renderWidget(QueueComponent);
