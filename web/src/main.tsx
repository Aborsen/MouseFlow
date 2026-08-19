/* The app's entry, on the same stack as insightis/apps/web: React 19, Vite, TanStack Router.
 *
 * Code-based routes rather than the file-based plugin. Seven routes is not enough to earn a code generator,
 * and one file that lists them all is easier to read than a directory whose names are the routing.
 */
import { RouterProvider, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './globals.css';
import { AppLayout } from '@/shell/AppLayout';
import { bootTheme } from '@/shell/theme';
import { RecordView } from '@/features/record/RecordView';
import { CreateView } from '@/features/create/CreateView';
import { SkillsView } from '@/features/skills/SkillsView';
import { GalleryView } from '@/features/gallery/GalleryView';
import { ConnectView } from '@/features/connect/ConnectView';
import { InsightsView } from '@/features/insights/InsightsView';

// Before the first paint, so the page does not flash the wrong colour on the way in.
bootTheme();

const rootRoute = createRootRoute({ component: AppLayout });

const routes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    // Landing on Record: the thing most visits came to do.
    beforeLoad: () => { throw redirect({ to: '/record' }); },
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/record', component: RecordView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/create', component: CreateView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/skills', component: SkillsView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/gallery', component: GalleryView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/insights', component: InsightsView }),
  /* The assistant lives on the Insights page now - the questions are about the numbers beside them, and a
   * separate screen made somebody retype the window they were looking at. Kept as a redirect rather than
   * deleted: /chat was live, and a bookmark that 404s is a worse answer than one that lands somewhere. */
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/chat',
    beforeLoad: () => { throw redirect({ to: '/insights' }); },
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/connect', component: ConnectView }),
  /* Every link written before this rewrite used a hash - #record, #skills, #gallery. Kept working rather
   * than silently landing people on the fallback. */
  createRoute({
    getParentRoute: () => rootRoute,
    path: '$',
    beforeLoad: () => { throw redirect({ to: '/record' }); },
  }),
];

const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

/* A hash from the old build - /#skills - is turned into a path once, on the way in. */
const hash = location.hash.replace(/^#/, '').split(/[?&]/)[0];
if (hash && ['record', 'create', 'skills', 'gallery', 'connect', 'desktop'].includes(hash)) {
  const to = hash === 'desktop' ? 'record' : hash;
  history.replaceState(null, '', `/${to}${location.search}`);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
