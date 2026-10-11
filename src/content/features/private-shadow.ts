const roots = new WeakMap<Element, ShadowRoot>();

/**
 * Attach a closed shadow root for extension UI.
 *
 * Open roots let page scripts read rendered translations back out and click
 * our controls, which turns the user's translation service into a proxy for
 * any website. Only extension code holds a reference to a closed root.
 */
export function attachPrivateShadow(host: Element): ShadowRoot {
  const root = host.attachShadow({ mode: "closed" });
  roots.set(host, root);
  return root;
}

/** Return the closed root that {@link attachPrivateShadow} created for `host`. */
export function privateShadowRoot(
  host: Element | null | undefined,
): ShadowRoot | null {
  return host ? (roots.get(host) ?? null) : null;
}
