/* The app's router, as much of it as a panel needs.
 *
 * The app is a routed single-page app; the panel is one box that shows one screen. Its views import four
 * things from @tanstack/react-router - Link, useNavigate, useRouterState, useParams - and every one of them
 * is about a URL the panel does not have.
 *
 * So the panel provides them, and the build aliases the package to this file. A Link becomes a button that
 * switches the panel's screen; a path the panel has no screen for opens the app in a tab, which is the
 * honest answer for /settings and the admin pages rather than a dead control.
 *
 * WHY NOT RUN THE REAL ROUTER. It would want a history, a route tree and a URL to own, in a page whose URL
 * is chrome-extension://…/sidepanel.html. Mapping four hooks is smaller than pretending an extension page
 * is a website, and it keeps the panel's own navigation - the rail - the only thing that decides what is on
 * screen.
 */
import type { AnchorHTMLAttributes, ReactNode } from 'react';

/** Set by the panel at mount, so a Link can move the rail. */
let go: ((path: string) => void) | null = null;
let where = '/record';

export const bindRouter = (onGo: (path: string) => void, current: string) => { go = onGo; where = current; };

const follow = (to: string) => { if (go) go(to); };

export const useNavigate = () => (opts: { to?: string } | string) => {
  follow(typeof opts === 'string' ? opts : opts?.to ?? '/');
};

export const useRouterState = <T,>(opts?: { select?: (state: { location: { pathname: string } }) => T }) => {
  const state = { location: { pathname: where } };
  return (opts?.select ? opts.select(state) : state) as T;
};

/** The panel has no route parameters; nothing it shows is addressed by one. */
export const useParams = () => ({}) as Record<string, string>;

export const Link = ({ to, children, ...rest }: {
  to: string;
  children?: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) => (
  <a
    {...rest}
    href={to}
    onClick={(ev) => { ev.preventDefault(); follow(to); }}
  >
    {children}
  </a>
);

/* Declared because the app's shell imports them; the panel never renders a route tree, so they are shapes
 * rather than behaviour, and anything that actually called one would be a bug worth the loud failure. */
export const Outlet = () => null;
export const redirect = (opts: unknown) => opts;
