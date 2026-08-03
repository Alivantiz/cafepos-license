import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Cloudflare Pages, «Advanced mode»: _worker.js обязан лежать в КОРНЕ сборки.
// Vite копирует всё из public/ в dist/ как есть — поэтому воркер и живёт там,
// а не в src/. Отдельного шага копирования не нужно.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
})
