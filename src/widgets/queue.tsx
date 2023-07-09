import {
  BuiltInPowerupCodes,
  RemHierarchyEditorTree,
  renderWidget,
  usePlugin,
  useRunAsync,
  useTracker,
  WidgetLocation,
} from '@remnote/plugin-sdk';

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
        if (await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) {
          return { rem, type: 'pdf' };
        } else {
          return { rem, type: 'rem' };
        }
      }
    },
    [ctx?.remId]
  );

  return <div>Incremental Rem!</div>;

  if (!remAndType) {
    return null;
  } else if (remAndType.type === 'pdf') {
    return null;
  } else if (remAndType.type === 'rem') {
    return <RemHierarchyEditorTree remId={remAndType.rem._id}></RemHierarchyEditorTree>;
  }
  return null;
}

renderWidget(QueueComponent);
