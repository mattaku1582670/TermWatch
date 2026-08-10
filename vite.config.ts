import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('./web', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/web', import.meta.url));

export default defineConfig({
  root: webRoot,
  base: './',
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2020',
    // インライン化するとCSP(script-src 'self')に反するため、必ず外部ファイルへ出す。
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
