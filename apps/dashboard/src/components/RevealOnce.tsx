"use client";

import type React from "react";

/**
 * Wrapper around the "freshly-minted plaintext key" panel.
 *
 * Previous versions of this component eagerly called `dismissRevealedKey()`
 * on client mount to delete the underlying reveal cookie — but that meant
 * a single hydration cycle erased the secret, so any later re-render
 * (router.refresh, AutoRefresh tick, browser back/forward, even a Next 15
 * server-action redirect that re-rendered the same page) lost the key
 * panel and dropped the user back into the placeholder copy. The panel
 * vanishing before the user could copy the key was a routine onboarding
 * complaint.
 *
 * Now we rely entirely on the cookie's existing 120s `maxAge` to clean
 * up the secret. Within that window the user can refresh, navigate
 * away, and come back — the panel keeps showing because the server
 * still finds the cookie. After 120s the cookie is gone and the panel
 * disappears on the next render.
 *
 * The component is kept as a marker / call site so future iteration
 * (e.g. an explicit "I copied it, hide now" button) has a place to live.
 */
export function RevealOnce({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
