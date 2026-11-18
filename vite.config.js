import { defineConfig } from 'vite'
import { createNexus, startUrl } from './server/index.js'

const port = Number(process.env.NEXUS_PORT || 5370)

// In development the backend runs inside the Vite dev server as middleware,
// so there is a single local port and no proxy.
function nexusBackend() {
  return {
    name: 'nexus-backend',
    configureServer(server) {
      const nexus = createNexus()
      server.middlewares.use(nexus.handle)
      server.httpServer?.once('listening', () => {
        const addr = server.httpServer.address()
        setTimeout(() => {
          console.log(`\n  NEXUS  project: ${nexus.root}`)
          console.log(`  Open:  ${startUrl(addr.port, nexus.token)}\n`)
        }, 50)
      })
      server.httpServer?.once('close', nexus.close)
    },
  }
}

export default defineConfig({
  plugins: [nexusBackend()],
  server: { host: '127.0.0.1', port, strictPort: true },
  preview: { host: '127.0.0.1' },
  build: { target: 'es2020', outDir: 'dist', emptyOutDir: true },
})
