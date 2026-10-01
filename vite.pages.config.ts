// Build para GitHub Pages: la página de crear/unirse partidas entre navegadores (client/p2p).
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    root: r('./client/p2p'),
    // rutas relativas: funciona en https://<usuario>.github.io/<repo>/
    base: './',
    build: {
        outDir: r('./dist-pages'),
        emptyOutDir: true,
        assetsInlineLimit: 0,
        chunkSizeWarningLimit: 4096,
    },
    resolve: {
        alias: {
            '@cs16': r('./vendor/cs16-client/cstrike'),
        },
    },
    server: {
        fs: { allow: [r('.')] },
    },
});
