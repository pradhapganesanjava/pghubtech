import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/pghubtech/',
  // Build id (stamped at build time) → appended as ?v= to the bundled iframe
  // URLs so each deploy busts the browser cache for knowledge_graph.html /
  // patterns.html / patterns-catalog.js instead of serving stale copies.
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
})
