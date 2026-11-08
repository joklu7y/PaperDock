import { defineConfig, mergeConfig } from 'vite';
import desktop from './vite.desktop.config';
import path from 'node:path';

export default mergeConfig(desktop, defineConfig({
  base: './',
  define: { __PAPERDOCK_MOBILE__: true },
  build: {
    outDir: path.resolve(__dirname, 'mobile/workbench-dist'),
    target: ['chrome100', 'safari16'],
  },
}));
