import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'desktop'),
  base: '/desktop/',
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss()] } },
  build: {
    outDir: path.resolve(__dirname, 'desktop-dist'),
    emptyOutDir: true,
  },
});
