import { defineConfig } from 'vite';
import { resolve } from 'path';

/**
 * Two entry points, one dev server.
 *
 *   /           landing, lobby browser, how to play
 *   /play.html  the game itself
 *
 * A separate Vite app for the landing page would mean a fourth process to
 * start, a fourth port to remember and a second copy of the design tokens.
 * Multi-page keeps one service and one stylesheet source of truth.
 */
export default defineConfig({
  server: { port: 5173, host: true },
  build: {
    rollupOptions: {
      input: {
        landing: resolve(__dirname, 'index.html'),
        play: resolve(__dirname, 'play.html'),
      },
    },
  },
});
