/* The side panel's entry. `globals.css` is the app's, so the panel inherits the palette, the fonts and
 * every token the shared components read - which is the whole point of building this with the app's Vite
 * config rather than by hand. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/globals.css';
import { Panel } from './Panel';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
);
