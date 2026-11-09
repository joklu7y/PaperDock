import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import path from 'node:path';

export const workbenchConfig = (mobile = false) => defineConfig({
  root: path.resolve(__dirname, 'desktop'),
  base: mobile ? './' : '/desktop/',
  publicDir: mobile ? path.resolve(__dirname, 'mobile/workbench/public') : undefined,
  define: { __PAPERDOCK_MOBILE__: mobile },
  resolve: {
    alias: {
      '#paperdock-runtime': path.resolve(__dirname, mobile ? 'mobile/workbench/runtime.ts' : 'desktop/workbench-runtime.ts'),
    },
  },
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss()] } },
  build: {
    outDir: path.resolve(__dirname, mobile ? 'mobile/workbench-dist' : 'desktop-dist'),
    emptyOutDir: true,
    target: mobile ? ['chrome100', 'safari16'] : undefined,
  },
});

export default workbenchConfig();
