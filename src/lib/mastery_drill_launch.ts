import { RNPlugin } from '@remnote/plugin-sdk';
import { MasteryDrillMode, masteryDrillModeId } from './consts';
import { getIESetting } from './settings';

/**
 * One way in to the Mastery Drill, for every button and command.
 *
 * The drill runs either in the popup's embedded queue or in RemNote's own queue
 * (lib/mastery_drill_native.ts), per the "Where the Drill Runs" setting.
 *
 * The regular-queue drill cannot be started from a widget directly: its state
 * must live in the plugin's index realm, where the GetNextCard callback reads it
 * synchronously and where registerCSS works. So widgets ask for it through a
 * session key that the index listens to. Commands go the same way, to keep a
 * single path.
 */

/** Session key: set to a timestamp to ask the index realm to start a regular-queue drill. */
export const nativeDrillStartRequestKey = 'mastery-drill-native-start-request';

/**
 * Session key the index realm publishes while a regular-queue drill is on screen,
 * for the drill bar in the queue.
 */
export const nativeDrillStateKey = 'mastery-drill-native-state';
export interface NativeDrillState {
  active: boolean;
  /** RemNote buried at least one drill card this session ("Time to Take a Break"). */
  buried: boolean;
}

export async function openMasteryDrill(plugin: RNPlugin, mode?: MasteryDrillMode): Promise<void> {
  const resolved = mode ?? (await getIESetting(plugin, masteryDrillModeId));
  if (resolved === 'native') {
    await plugin.storage.setSession(nativeDrillStartRequestKey, Date.now());
  } else {
    await plugin.widget.openPopup('mastery_drill');
  }
}
