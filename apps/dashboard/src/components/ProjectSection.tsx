"use client";

import type { ReactNode } from "react";
import { useActiveSection } from "./ProjectDetailLayout";

/**
 * Wrapper that keeps a stable hash target (`id`) in the DOM for every
 * project section while rendering the heavy children only when active.
 * This avoids flaky fragment behavior for `/projects/<id>#alerts`: the
 * anchor exists even before the active section sync effect flips from the
 * default tab to the hash tab.
 *
 * The wrapped section's own anchor `id` (used by sidebar links and
 * external deep-link bookmarks) lives on the wrapper div so the URL
 * fragment behavior matches what users expect.
 */

type ProjectSectionProps = {
  id: string;
  children: ReactNode;
  /** Optional: extra props to forward onto the wrapper div, mostly
   *  useful when the original outer card had margin / padding we
   *  want to preserve in the new tabbed layout. */
  className?: string;
};

export function ProjectSection({ id, children, className }: ProjectSectionProps) {
  const active = useActiveSection();
  const isActive = active === id;
  return (
    <section id={id} className={className} hidden={!isActive}>
      {isActive ? children : null}
    </section>
  );
}
