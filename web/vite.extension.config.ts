/* The extension, built from the app's own components.
 *
 * WHY THIS CONFIG EXISTS AT ALL. The extension used to be plain HTML with a system-colour stylesheet, and
 * the app is React on a vendored design system. Asking the two to look alike by hand is the thing this
 * repository spent a day undoing everywhere else: four search boxes that had drifted apart, eight outcome
 * lines of which one was announced to a screen reader. A second copy of a design is a copy that diverges.
 *
 * So the extension's panel is built from `web/src` - the same Button, Pill, Said, SearchField, SelectionBar
 * and palette the app renders - and the only reason this is a SEPARATE config rather than more entries in
 * vite.config.ts is the output: Chrome loads a directory, and that directory has to hold a manifest, a
 * service worker and content scripts that are NOT bundled.
 *
 * WHAT IS AND IS NOT BUNDLED, because getting this wrong is a silent failure:
 *
 *   bundled     sidepanel.html + popup.html and everything they import - React, the design system, the
 *               palette. These are ordinary pages; Chrome's CSP for extension pages allows their scripts
 *               because they ship inside the package.
 *   copied      manifest.json, background.js, content.js, bridge.js, agent.js, skills.js, icons/. The
 *               service worker and the content scripts run in worlds where a bundler's module graph is a
 *               liability rather than a help, and they have no UI. They are hand-written and stay so.
 *
 * The result lands in extension/dist, which is what "Load unpacked" is pointed at now.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const ui = (p: string) => here('./vendor/insightis-ui/' + p);
const OUT = here('../extension/dist');

/* The same alias list vite.config.ts carries, and for the same reason - see the long note there. Restated
 * rather than imported because a config that imports another config is two configs with one name. */
const DESIGN_SYSTEM = [
  { find: '@insightis/ui/cn', replacement: ui('src/lib/utils.ts') },
  { find: '@insightis/ui/use-mobile', replacement: ui('src/hooks/use-mobile.tsx') },
  { find: '@insightis/ui/globals.css', replacement: ui('src/globals.css') },
  { find: /^@insightis\/ui\/(.+)$/, replacement: ui('src/components/$1/index.tsx') },
  { find: /^@\/hooks\/(.+)$/, replacement: ui('src/hooks/$1') },
];

/** The hand-written half, copied in whole. Named one by one: a glob would quietly ship whatever is added.
 *
 * И ОБОРОТНАЯ СТОРОНА ЭТОГО РЕШЕНИЯ, которая стоила одной поломки: файл, который ПОЯВИЛСЯ и который
 * импортирует уже копируемый, в сборку молча не попадает - и ломается она не здесь, а в Chrome, при
 * загрузке модуля, у человека. Ровно это случилось с `procedure.js` (mouseflow.skill/2): `skills.js`
 * стал его импортировать, список не тронули, и собранное расширение получило импорт в пустоту.
 *
 * Список остаётся поимённым - глоб отправил бы в пакет что угодно, включая тесты и черновики, - но
 * теперь его полнота ПРОВЕРЯЕТСЯ: каждый относительный импорт копируемого файла обязан сам быть в
 * списке. Проверка живёт в extension/check-extension.mjs, то есть падает на `npm test`, а не в Chrome. */
const COPY = [
  'manifest.json',
  'background.js',
  'content.js',
  'bridge.js',
  'agent.js',
  'skills.js',
  /* Читается skills.js - см. заметку выше про то, почему это отдельная строка, а не глоб. */
  'procedure.js',
  /* Читается background.js. ОТСУТСТВОВАЛ С bcdb9ae (пункт 8 роадмапа): файл добавили, список не
   * тронули, и с того коммита собранный воркер не поднимался вовсе - импорт вёл в никуда. Нашла это
   * проверка замыкания в extension/check-extension.mjs, добавленная из-за procedure.js. */
  'checks.js',
  'icons',
];

/* ЛОКАЛЬНАЯ РАЗРАБОТКА - ТОЛЬКО ПО ПРОСЬБЕ, И ГРОМКО.
 *
 * `http://localhost/*` и `http://127.0.0.1/*` стояли в выпускаемом манифесте, и Chrome в таких шаблонах
 * порт игнорирует - то есть мост внедрялся в КАЖДУЮ страницу на КАЖДОМ порту localhost. Не гипотетическую:
 * локальный превью проекта, документация под `python -m http.server`, веб-интерфейс любой установленной
 * программы. Такая страница одним window.postMessage перепривязывала расширение к чужому аккаунту, после
 * чего скиллы человека уезжали туда, а оттуда приезжали чужие - синхронизация двусторонняя.
 *
 * Разработке они по-прежнему нужны, поэтому не удалены, а вынесены за флаг. Флаг печатает предупреждение:
 * сборка, которую нельзя выпускать, обязана говорить об этом в тот момент, когда её делают, а не в тот,
 * когда кто-то заметит лишнюю строку в манифесте. */
const DEV_BRIDGE = ['http://localhost/*', 'http://127.0.0.1/*'];

function openManifestForDev(path: string) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.externally_connectable.matches.push(...DEV_BRIDGE);
  for (const entry of manifest.content_scripts) entry.matches.push(...DEV_BRIDGE);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

const packExtension = (): Plugin => ({
  name: 'mouseflow-pack-extension',
  apply: 'build',
  closeBundle() {
    const from = here('../extension');
    for (const name of COPY) {
      const src = join(from, name);
      if (!existsSync(src)) throw new Error(`extension/${name} is missing - the build would ship without it`);
      cpSync(src, join(OUT, name), { recursive: true });
    }
    /* Правится КОПИЯ в dist, а не исходник: иначе разработочная сборка оставила бы после себя изменённый
     * manifest.json, и первый же коммит выпустил бы то, что здесь и закрывается. */
    if (process.env.MOUSEFLOW_DEV_BRIDGE === '1') {
      openManifestForDev(join(OUT, 'manifest.json'));
      console.warn('\n  ⚠ MOUSEFLOW_DEV_BRIDGE=1 — localhost is in this build\'s manifest.');
      console.warn('    Any page on any localhost port can talk to this extension. Do not ship it.\n');
    }
  },
});

export default defineConfig({
  plugins: [react(), packExtension()],
  resolve: {
    alias: [
      ...DESIGN_SYSTEM,
      /* The router, replaced. The app's screens import Link, useNavigate, useRouterState and useParams -
       * all four about a URL a panel does not have - and the shim turns them into the panel's own
       * navigation. See web/src/extension/router-shim.tsx for why this is smaller than running the real
       * router in a page whose address is chrome-extension://…/sidepanel.html.
       *
       * FIRST in the list, before the '@' alias, because order decides. */
      { find: '@tanstack/react-router', replacement: here('./src/extension/router-shim.tsx') },
      { find: '@', replacement: here('./src') },
    ],
  },
  /* RELATIVE, not absolute. An extension page resolves `/assets/…` against the package root, so absolute
   * would work inside Chrome and break the moment somebody opens the built file to look at it - which is
   * how it gets checked during development. */
  base: './',
  /* The app's public/ is not the extension's. Left on, Vite copies the web app's service worker, its web
   * manifest and the agent downloads into the package - none of which belong in a browser extension, and
   * two of which are a manifest and a worker Chrome would be right to be confused by. */
  publicDir: false,
  build: {
    outDir: OUT,
    emptyOutDir: true,
    rollupOptions: {
      /* At the web root, NOT beside their .tsx files. Vite emits an html entry at its path relative to the
       * root and rewrites its asset urls to match that depth - so an entry nested two levels down came out
       * asking for `../../assets/…`, and moving the file afterwards left those paths pointing above the
       * package. Kept flat instead, which is the fix rather than a workaround. */
      input: {
        sidepanel: here('./sidepanel.html'),
        popup: here('./popup.html'),
      },
      /* Flat, predictable names. A manifest cannot reference a hashed filename, and while only the html is
       * named there, a stable layout is easier to look at in chrome://extensions. */
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
