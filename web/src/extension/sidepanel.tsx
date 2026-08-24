/* The side panel's entry. `globals.css` is the app's, so the panel inherits the palette, the fonts and
 * every token the shared components read - which is the whole point of building this with the app's Vite
 * config rather than by hand. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/globals.css';
/* BEFORE the panel and everything it pulls in: the shim replaces globalThis.fetch, and a module that
 * captured the real one at import time would keep talking to an origin this page does not have. */
import { installApiBridge } from './api-bridge';
import { Panel } from './Panel';

installApiBridge();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
);
