import {
  BuiltInPowerupCodes,
  PDFWebReader,
  PowerupSlotCodeMap,
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
import { scheduleRem } from '../lib/scheduler';

const BOTTOM_BAR_HEIGHT = 50;

interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
}

function Button(props: ButtonProps) {
  return (
    <button
      className="bg-blue-50 hover:bg-blue-70 text-white font-bold py-2 px-4 rounded"
      style={{
        height: '40px',
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

interface BottomBarProps {
  rem: Rem;
}

function BottomBar(props: BottomBarProps) {
  const plugin = usePlugin();
  return (
    <div className="flex flex-row justify-center items-center gap-4">
      <Button
        onClick={async () => {
          await scheduleRem(plugin, props.rem._id);
          await plugin.queue.removeCurrentCardFromQueue();
        }}
      >
        Next
      </Button>
    </div>
  );
}

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
          height: `calc(100% - ${BOTTOM_BAR_HEIGHT}px)`,
        }}
      >
        {(() => {
          if (!remAndType) {
            return null;
          } else if (remAndType.type === 'pdf') {
            return <PDFWebReader remId={remAndType.rem._id} />;
          } else if (remAndType.type === 'web') {
            return <PDFWebReader remId={remAndType.rem._id} height={'100%'} width="100%" />;
          } else if (remAndType.type === 'youtube') {
            return <VideoViewer rem={remAndType.rem} />;
          } else if (remAndType.type === 'rem' && shouldRenderEditorForRemType) {
            // TODO: how to make sure the bottom bar always gets rendered at the bottom if other plugins are also rendering widgets?
            return (
              <div className="flex flex-col gap-2">
                <RemRichTextEditor remId={remAndType.rem._id} width={'100%'} />
                <RemHierarchyEditorTree
                  width={'100%'}
                  height={`calc(100% - ${BOTTOM_BAR_HEIGHT}px)`}
                  maxHeight={`calc(100% - ${BOTTOM_BAR_HEIGHT}px)`}
                  remId={remAndType.rem._id}
                ></RemHierarchyEditorTree>
              </div>
            );
          }
          return null;
        })()}
      </div>
      <div
        className="rounded-b-2xl"
        style={{
          height: `${BOTTOM_BAR_HEIGHT}px`,
          maxHeight: `${BOTTOM_BAR_HEIGHT}px`,
        }}
      >
        {remAndType && <BottomBar rem={remAndType?.rem}></BottomBar>}
      </div>
    </div>
  );
}

renderWidget(QueueComponent);
