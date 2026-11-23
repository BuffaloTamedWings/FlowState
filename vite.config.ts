import { cp, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const repoRoot = resolve(import.meta.dirname);
const dataDir = resolve(repoRoot, 'data');

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.geojson': 'application/geo+json; charset=utf-8',
};

/**
 * `data/` lives outside the Vite root (`web/`), so serve it at `/data/*` in dev
 * and copy it into `dist/data/` on build. Nothing in `data/` is ever written.
 */
function serveDataDir(): Plugin {
  return {
    name: 'flowstate-serve-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? '';
        if (!url.startsWith('/data/')) return next();
        const rel = normalize(decodeURIComponent(url.slice('/data/'.length)));
        const file = join(dataDir, rel);
        if (!file.startsWith(dataDir)) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }
        stat(file).then(
          (s) => {
            if (!s.isFile()) return next();
            res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
            createReadStream(file).pipe(res);
          },
          () => next(),
        );
      });
    },
    async closeBundle() {
      await cp(dataDir, resolve(repoRoot, 'web/dist/data'), { recursive: true });
    },
  };
}

export default defineConfig({
  root: 'web',
  plugins: [serveDataDir()],
  resolve: {
    alias: {
      '@shared': resolve(repoRoot, 'shared'),
      '@engine': resolve(repoRoot, 'engine/src'),
      '@web': resolve(repoRoot, 'web/src'),
    },
  },
  server: {
    fs: {
      // Allow importing source from outside web/ (shared/, engine/src/).
      allow: [repoRoot],
    },
  },
});
