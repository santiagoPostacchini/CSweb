import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    root: r('./client'),
    build: {
        outDir: r('./dist'),
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
        // "npm run dev:client" usa el servidor de "npm start" para la API y la señalización
        proxy: {
            '/api': 'http://localhost:27016',
            '/game': 'http://localhost:27016',
            '/signal': { target: 'ws://localhost:27016', ws: true },
        },
    },
});
