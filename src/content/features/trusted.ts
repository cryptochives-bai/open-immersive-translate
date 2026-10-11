/**
 * True only for events the browser produced from real user input.
 *
 * Content scripts share the DOM with the page, so page scripts can dispatch
 * look-alike keyboard, pointer, and click events that reach our listeners.
 * Without this gate any website could drive the user's configured (possibly
 * paid) translation service and read the results back. Page scripts cannot
 * forge `isTrusted`.
 */
export function isUserEvent(event: Event): boolean {
  return event.isTrusted;
}
