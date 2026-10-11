import type { ComponentProps } from "react";
import { Link, useLocation } from "react-router";

/**
 * A link to a section of a page, like "/#privacy". On the section's own page it
 * glides there on every click (a router link only scrolls when the URL changes);
 * from elsewhere it navigates and the router scrolls to the section on arrival.
 */
export function SectionLink({ to, onClick, ...props }: Omit<ComponentProps<"a">, "href"> & { to: string }) {
  const { pathname } = useLocation();
  const [path, hash] = to.split("#");
  if (hash && (path || "/") === pathname) {
    return (
      <a
        href={`#${hash}`}
        onClick={(event) => {
          onClick?.(event);
          const target = document.getElementById(hash);
          if (!target || event.defaultPrevented) return;
          event.preventDefault();
          const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
        }}
        {...props}
      />
    );
  }
  return <Link to={to} onClick={onClick} {...props} />;
}
