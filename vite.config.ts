import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: './',
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/.analysis/**', '**/.tools/**', '**/src-tauri/**', '**/docs/**'] },
  },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022', sourcemap: false },
});
