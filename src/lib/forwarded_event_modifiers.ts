/* Keep Shift/Ctrl/Alt/Meta on clicks that land on a RemNote component embed.

   <RemViewer>, <RichText>, <Queue> and the other SDK components are "fake embeds":
   RemNote draws them in its own page, on top of our iframe, so the real mouse event
   happens over there. The host copies the event's plain fields (Underscore
   `_.pick(event, primitive)`, which includes shiftKey, ctrlKey, button…) and sends them
   over, and the SDK replays them on the placeholder div as

       new Event(payload.type, { ...payload, bubbles: true })

   A plain Event takes nothing from that init dict except bubbles/cancelable/composed,
   so React's onClick gets `e.shiftKey === undefined`. Every "Shift+click to open in
   a new pane" on a Rem's text therefore opened in place. Only clicks outside the embed
   (the "Seen 6m ago" line under it) carried the modifier.

   The fix wraps the iframe's global Event constructor. When the init dict is one of
   those forwarded payloads (it carries `isTrusted`, which no hand-built init does), the
   wrapper copies the mouse/modifier fields onto the new event as own properties. Every
   other `new Event(...)` gets the native constructor's result unchanged. `instanceof
   Event` still holds both ways because the wrapper shares Event.prototype.

   Imported for its side effect by HoverTipLayer, which every widget mounts. */

const FORWARDED_FIELDS = [
  'shiftKey',
  'ctrlKey',
  'altKey',
  'metaKey',
  'button',
  'buttons',
  'detail',
  'clientX',
  'clientY',
  'screenX',
  'screenY',
  'key',
  'code',
  'repeat',
] as const;

const PATCH_FLAG = '__incrementalForwardedEventModifiers';

function install(): void {
  if (typeof window === 'undefined' || typeof window.Event !== 'function') return;
  const w = window as unknown as Record<string, unknown>;
  if (w[PATCH_FLAG]) return;

  const NativeEvent = window.Event;

  function ForwardingEvent(this: unknown, type: string, init?: EventInit & Record<string, unknown>) {
    const event: Event = Reflect.construct(NativeEvent, [type, init], new.target ?? ForwardingEvent);
    if (init && typeof init === 'object' && 'isTrusted' in init) {
      for (const field of FORWARDED_FIELDS) {
        if (field in init && !(field in event)) {
          try {
            Object.defineProperty(event, field, { value: init[field], enumerable: true });
          } catch {
            // A field the platform already defines: leave it alone.
          }
        }
      }
    }
    return event;
  }
  ForwardingEvent.prototype = NativeEvent.prototype;
  Object.setPrototypeOf(ForwardingEvent, NativeEvent);

  try {
    w.Event = ForwardingEvent;
    w[PATCH_FLAG] = true;
  } catch {
    // window.Event not writable here: keep the native one.
  }
}

install();

export {};
