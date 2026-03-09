import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  root: "src/renderer",
  build: {
    // Output goes to project-root/dist so Express can serve it with:
    //   app.use(express.static(path.join(__dirname, '../../dist')))
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // In dev mode, proxy all /api/* requests to the Express server running on
    // port 3000.  This avoids CORS issues during development and matches the
    // production URL structure (same origin for UI and API).
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
