import { RNPlugin } from '@remnote/plugin-sdk';

export const MESSAGE_POPUP = 'message_popup';

export interface MessageDialog {
  title: string;
  message: string;
  /** Text shown in a box under the message, e.g. the passage that was looked for. */
  quote?: string;
  /** Smaller explanation under everything else. */
  detail?: string;
  tone?: 'error' | 'info';
}

/**
 * Show a message the user has to read — a failure they need to act on. A toast
 * is the wrong channel for these: a plugin toast raised while another one is
 * still on screen can go unseen.
 */
export const showMessageDialog = (plugin: RNPlugin, dialog: MessageDialog) =>
  plugin.widget.openPopup(MESSAGE_POPUP, { dialog });
