// Build the client and the spectator into ONE static site (web-dist/):
//
//   /             landing + lobbies     (client)
//   /play.html    the game              (client)
//   /spectate/    the spectator         (spectator, built under that base path)
//
// One deployment, one URL to share. The game server stays separate (it holds
// WebSockets and a tick loop, which a static host can't run); its address
// comes from KHIANA_SERVER_URL, or VITE_API_URL / VITE_WS_URL if set directly.
//
//   KHIANA_SERVER_URL=https://<server> node scripts/build-web.mjs
import { execSync } from 'child_process';
import { cpSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = process.env.KHIANA_SERVER_URL ?? 'https://khiana-production-e696.up.railway.app';
const env = {
  ...process.env,
  VITE_API_URL: process.env.VITE_API_URL ?? server,
  VITE_WS_URL: process.env.VITE_WS_URL ?? server.replace(/^http/, 'ws'),
  // Same site, so the landing page links to the spectator by path.
  VITE_SPECTATOR_URL: process.env.VITE_SPECTATOR_URL ?? '/spectate/',
};
const run = (cmd, cwd) => execSync(cmd, { cwd: join(root, cwd), env, stdio: 'inherit' });

const out = join(root, 'web-dist');
rmSync(out, { recursive: true, force: true });

run('npx vite build --outDir ../web-dist --emptyOutDir', 'client');
run('npx vite build --base /spectate/ --outDir ../web-dist/spectate --emptyOutDir', 'spectator');

console.log(`\nweb-dist/ ready · server ${env.VITE_API_URL}`);
