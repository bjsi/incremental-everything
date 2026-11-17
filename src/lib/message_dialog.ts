import { RNPlugin } from '@remnote/plugin-sdk';

export const MESSAGE_POPUP = 'message_popup';

export interface MessageDialog {
  title: string;
  message: string;
  /** Text shown in a box under the message, e.g. the passage that was looked for. */
  quote?: string;
  /** Smaller explanation under everything else. */
  detail?: string;
  /** One box per entry under the message, e.g. one per quote of a bulk run. */
  items?: MessageItem[];
  tone?: 'error' | 'info' | 'success';
  /** Adds an "Open Rem" button (←→ to reach it) that opens this Rem and closes the dialog. */
  openRemId?: string;
}

export interface MessageItem {
  /** Shown in italics at the top of the box (a quote). */
  title: string;
  lines: string[];
  /** ok = done (green edge), miss = not done (amber edge). */
  tone?: 'ok' | 'miss';
}

/**
 * Show a message the user has to read — a failure they need to act on. A toast
 * is the wrong channel for these: a plugin toast raised while another one is
 * still on screen can go unseen.
 */
export const showMessageDialog = (plugin: RNPlugin, dialog: MessageDialog) =>
  plugin.widget.openPopup(MESSAGE_POPUP, { dialog });
