import {
  PluginRem,
  RemHierarchyEditorTree,
  RemViewer,
  renderWidget,
  usePlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React from 'react';
import '../style.css';
import '../App.css';
import { withHoverTips } from '../components/HoverTipLayer';
import { extraCardDetailsOf, setClusterExtraDetailOverride } from '../lib/cluster_extra_detail';
import { clusterExtraDetailOverrideKey } from '../lib/consts';

// Extra details for the Card Cluster member being tested (lib/cluster_extra_detail).
// RemNote mounts the FlashcardExtraDetail slot when the answer is revealed and drops
// it when the cluster moves to its next member, so each member gets a fresh mount
// and a fresh context. Outside a mismatch this renders nothing and RemNote's own
// block stays.

type Detail = { rem: PluginRem; hasChildren: boolean };

function ClusterExtraDetail() {
  const plugin = usePlugin();
  const [details, setDetails] = React.useState<Detail[] | null>(null);

  React.useEffect(() => {
    let mounted = true;
    let overriding = false;
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.FlashcardExtraDetail>();
      const card = ctx?.cardId ? await plugin.card.findOne(ctx.cardId) : undefined;
      const testedRemId = card?.remId;
      if (!mounted) return;
      if (!testedRemId || testedRemId === ctx?.remId) {
        // RemNote's block is right. Clear a switch a torn-down instance left on.
        await setClusterExtraDetailOverride(plugin, false);
        return;
      }
      const rem = await plugin.rem.findOne(testedRemId);
      const ecds = rem ? await extraCardDetailsOf(rem) : [];
      const withChildren = await Promise.all(
        ecds.map(async (r) => ({ rem: r, hasChildren: (await r.getChildrenRem()).length > 0 }))
      );
      if (!mounted) return;
      overriding = true;
      await setClusterExtraDetailOverride(plugin, true);
      if (mounted) setDetails(withChildren);
    })();
    return () => {
      mounted = false;
      // A lone setSession survives the iframe's teardown; the CSS is also gated on
      // this iframe being on the page, so a lost write only lasts until the next mount.
      if (overriding) void plugin.storage.setSession(clusterExtraDetailOverrideKey, false);
    };
  }, [plugin]);

  if (!details || details.length === 0) return null;
  return (
    <div className="pt-3 pb-3" style={{ borderTop: '1px solid var(--rn-clr-border-opaque)' }}>
      <div className="text-xs font-semibold uppercase tracking-wider text-[rgb(19,91,150)] dark:text-sky-300">
        Extra details
      </div>
      <div className="mt-3 flex flex-col gap-3">
        {details.map(({ rem, hasChildren }) => (
          <div key={rem._id}>
            <RemViewer remId={rem._id} width="100%" />
            {hasChildren && (
              <div className="ml-4">
                <RemHierarchyEditorTree remId={rem._id} width="100%" height="auto" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

renderWidget(withHoverTips(ClusterExtraDetail));
