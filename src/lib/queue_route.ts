/**
 * Which of RemNote's queues a URL path belongs to. `plugin.window.getURL()`
 * returns `window.location.pathname`. Routes read from the 1.28.19 bundle:
 *
 *   /flashcards                                   the daily queue
 *   /flashcards/<id>                              Practice with Spaced Repetition (a document)
 *   /flashcards/<id>/all, /ordered, /all_no_srs, /ordered_no_srs   Practice All and In Order
 *   /flashcards/<id>/need_to_learn                a document's Need to Learn cards
 *   /need_to_learn/<examId>/<documentId>/<order>  the Learn New queue
 *
 * Anything else — the filtered queues, a queue shown inside a document — is 'other'.
 */
export type QueueRouteKind = 'spaced' | 'learn-new' | 'other';

export function queueRouteKind(path: string | null | undefined): QueueRouteKind {
  if (typeof path !== 'string') return 'other';
  const clean = path.replace(/\/+$/, '');
  if (clean.startsWith('/need_to_learn/')) return 'learn-new';
  const match = /^\/flashcards(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(clean);
  if (!match) return 'other';
  const mode = match[2];
  if (!mode) return 'spaced';
  return mode === 'need_to_learn' ? 'learn-new' : 'other';
}
