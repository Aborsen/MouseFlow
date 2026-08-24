/* Just enough of the extension API to type the panel.
 *
 * NOT @types/chrome. That package is 8,000 lines describing every API this extension does not use, and it
 * would be a dependency of the WEB app's build - which is where these files are compiled from - for the
 * sake of four calls. What the panel touches is declared here, and anything it starts touching has to be
 * added deliberately, which is the useful half of what a type package would have given.
 *
 * `chrome` is possibly undefined on purpose: these pages are also opened in an ordinary tab while being
 * worked on, and code that assumed the object exists would throw on the first line rather than render.
 */
declare namespace chrome {
  const runtime: {
    id?: string;
    sendMessage(message: unknown): Promise<unknown>;
  } | undefined;

  const tabs: {
    create(options: { url: string; active?: boolean }): Promise<unknown>;
    query(options: { active?: boolean; currentWindow?: boolean }): Promise<{ windowId?: number }[]>;
  };

  const sidePanel: {
    open(options: { windowId: number }): Promise<void>;
  };
}
