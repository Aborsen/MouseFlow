/* Their tailwind config, consumed as a preset rather than transcribed.
 *
 * This file used to be a line-for-line copy of vendor/insightis-ui/tailwind.config.ts - every shadow, every
 * keyframe, the `pressed:` variant - which meant a token added upstream silently did not exist here until
 * somebody noticed and copied it across. As a preset there is nothing to keep in step.
 *
 * All that is left is what is genuinely ours: where the classes are, which now includes the vendored tree,
 * because a component's classes have to be in the content globs or Tailwind never emits them.
 */
import type { Config } from 'tailwindcss';
import designSystem from './vendor/insightis-ui/tailwind.config';

const config: Config = {
  presets: [designSystem],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './vendor/insightis-ui/src/**/*.{ts,tsx}',
  ],
};

export default config;
