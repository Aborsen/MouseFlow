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
import { ActivityView } from '@/features/activity/ActivityView';
import { SkillsView } from '@/features/skills/SkillsView';
import { GalleryView } from '@/features/gallery/GalleryView';
import { ConnectView } from '@/features/connect/ConnectView';
import { McpView } from '@/features/mcp/McpView';
import { SignInView } from '@/features/auth/SignInView';
import { SignUpView } from '@/features/auth/SignUpView';
import { ResetPasswordView } from '@/features/auth/ResetPasswordView';
import { AdminShell } from '@/features/admin/shell';
import { AdminOverview } from '@/features/admin/AdminOverview';
import { AdminUsers } from '@/features/admin/AdminUsers';
import { AdminUser } from '@/features/admin/AdminUser';
import { AdminModels } from '@/features/admin/AdminModels';
import { InsightsView } from '@/features/insights/InsightsView';
import { DocsView } from '@/features/docs/DocsView';
import { TeamView } from '@/features/team/TeamView';
import { ErrorBoundary, startReporting } from '@/lib/sentry';

/* Before anything else, so a crash while the app is still starting is still reported. Does nothing at all
 * unless VITE_SENTRY_DSN is set — see lib/sentry.ts, which is mostly about what it deliberately does not
 * send. */
startReporting();

// Before the first paint, so the page does not flash the wrong colour on the way in.
bootTheme();

const rootRoute = createRootRoute({ component: AppLayout });

/* Declared before the list so its children can name it as their parent. */
const adminRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin', component: AdminShell });

const routes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    // Landing on Record: the thing most visits came to do.
    beforeLoad: () => { throw redirect({ to: '/record' }); },
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/record', component: RecordView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/create', component: CreateView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/activity', component: ActivityView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/skills', component: SkillsView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/gallery', component: GalleryView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/dashboard', component: InsightsView }),
  /* ДВА маршрута на один экран, и это не дубликат: список документов и один документ - одно состояние
   * (что загружено, что отказало, что сказано), и разделять их значило бы завести всё это дважды ради
   * одного условия. Идентификатор в АДРЕСЕ, а не в состоянии, по тому же правилу, что уже держит срез
   * дашборда: документ - это то, что посылают коллеге, и ссылка на него обязана открывать его. */
  /* СПИСОК документов живёт вкладкой в Галерее - см. GalleryView. Этот адрес был живым ровно один день, и
   * всё-таки перенаправляет, а не удалён: его отдавал ассистент в ответе про написанный документ, и
   * закладка, отвечающая 404, - худший ответ, чем закладка, приводящая куда надо. */
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/docs',
    beforeLoad: () => { throw redirect({ to: '/gallery', search: { tab: 'documents' } as never }); },
  }),
  /* ОДИН документ - по-прежнему свой адрес и своя страница: его посылают коллеге, и открываться он обязан
   * сразу на себе, а не на списке, из которого его надо ещё найти. */
  createRoute({ getParentRoute: () => rootRoute, path: '/docs/$docId', component: DocsView }),
  /* The old path. A rename should not break a link somebody already has - and this one is in a published
   * review of the roadmap, which is exactly the sort of link nobody thinks about until it 404s. */
  createRoute({ getParentRoute: () => rootRoute, path: '/insights', component: InsightsView }),
  /* The assistant lives on the Insights page now - the questions are about the numbers beside them, and a
   * separate screen made somebody retype the window they were looking at. Kept as a redirect rather than
   * deleted: /chat was live, and a bookmark that 404s is a worse answer than one that lands somewhere. */
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/chat',
    beforeLoad: () => { throw redirect({ to: '/dashboard' }); },
  }),
  /* Teams. A module of its own since it stopped being a roster and became a place: several teams, the
   * people in them, and the button through to the dashboard scoped to one. */
  createRoute({ getParentRoute: () => rootRoute, path: '/team', component: TeamView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/connect', component: ConnectView }),
  /* The one page that is about the product rather than part of it, and the only route readable with no
   * account - see PUBLIC_PATHS. It is what "add MouseFlow to Claude" points at. */
  createRoute({ getParentRoute: () => rootRoute, path: '/mcp', component: McpView }),
  /* The three ways in. Reachable while signed OUT, which is the whole point - the account provider lets
   * these through its wall rather than showing it, because a wall in front of the sign-up page is a door
   * that only opens from inside. */
  createRoute({ getParentRoute: () => rootRoute, path: '/sign-in', component: SignInView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/sign-up', component: SignUpView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/reset-password', component: ResetPasswordView }),
  /* The back office, with a frame of its own.
   *
   * Reached by its address and deliberately absent from the product's sidebar: the SERVER decides who is
   * an admin (ADMIN_EMAILS), and to everyone else both the endpoint and every screen answer the same
   * not-found. A layout route rather than one page with tabs, so each section is a real address that can
   * be linked, bookmarked and gone back from. */
  adminRoute.addChildren([
    createRoute({ getParentRoute: () => adminRoute, path: '/', component: AdminOverview }),
    createRoute({ getParentRoute: () => adminRoute, path: '/users', component: AdminUsers }),
    createRoute({ getParentRoute: () => adminRoute, path: '/users/$id', component: AdminUser }),
    createRoute({ getParentRoute: () => adminRoute, path: '/models', component: AdminModels }),
  ]),
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

/* What somebody sees when a render throws.
 *
 * There was nothing here before, which means the failure mode for any uncaught error in a component was a
 * WHITE PAGE — no message, no way back, and nothing in the console that a person who is not a developer
 * would think to look at. That is worse than the error. So: a card that says the truth, a button that
 * reloads, and the report going out on its own.
 *
 * Outside StrictMode on purpose. StrictMode double-invokes render in development to surface side effects,
 * and a boundary inside it catches each of those twice. */
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary
    fallback={({ resetError }) => (
      <div className="grid min-h-screen place-items-center bg-surface-page p-6 text-center">
        <div className="max-w-[46ch]">
          <h1 className="font-semibold text-[1.15rem] text-ink-primary">This screen stopped working</h1>
          <p className="mt-2 text-[0.9rem] text-ink-secondary leading-relaxed">
            The problem has been reported. Nothing you recorded is affected — recordings live in this
            browser and on your account, not in this page.
          </p>
          <button
            type="button"
            onClick={() => { resetError(); location.reload(); }}
            className="mt-4 rounded-lg bg-brand-primary px-4 py-2 font-semibold text-[0.9rem] on-accent"
          >
            Reload the page
          </button>
        </div>
      </div>
    )}
  >
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  </ErrorBoundary>,
);
