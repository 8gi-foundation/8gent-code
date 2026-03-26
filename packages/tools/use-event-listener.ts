import { useEffect } from 'react';

/**
 * Attaches an event listener to the specified target and cleans it up on unmount.
 * @param target - The EventTarget to attach the listener to (e.g. window, document).
 * @param event - The event name to listen for.
 * @param handler - The handler function to execute when the event occurs.
 * @param options - Optional options for addEventListener.
 */
export function useEventListener(
  target: EventTarget | null,
  event: string,
  handler: (event: Event) => void,
  options?: AddEventListenerOptions | boolean
): void {
  useEffect(() => {
    if (!target) return;

    const listener = (e: Event) => handler(e);
    target.addEventListener(event, listener, options);

    return () => {
      target.removeEventListener(event, listener, options);
    };
  }, [target, event, handler, options]);
}