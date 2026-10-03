import { defineConfig } from 'vite'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const SETTINGS_FILE = fileURLToPath(new URL('./public/settings.json', import.meta.url))
const MAX_SETTINGS_BYTES = 256 * 1024

// Endpoint só do `npm run dev`: o botão "Salvar configurações" do painel manda
// os valores para cá e eles são gravados em public/settings.json
function saveSettingsPlugin() {
  return {
    name: 'save-settings',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__settings', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
          if (body.length > MAX_SETTINGS_BYTES) req.destroy() // corpo absurdo: corta
        })
        req.on('end', async () => {
          try {
            const json = JSON.parse(body)
            if (typeof json !== 'object' || json === null || !json.folders) throw new Error('formato inesperado')
            await writeFile(SETTINGS_FILE, JSON.stringify(json, null, 2) + '\n')
            res.end('ok')
          } catch (err) {
            res.statusCode = 400
            res.end(String(err))
          }
        })
      })
    },
  }
}

// base relativo: funciona no GitHub Pages (subpasta) e em domínio próprio
export default defineConfig({
  base: './',
  plugins: [saveSettingsPlugin()],
  build: {
    // O three.js sozinho tem ~520 kB (normal para ele); o aviso fica para
    // quando o código do jogo crescer além disso
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Bibliotecas em arquivos próprios: mudam raramente, então o navegador
        // as mantém em cache entre versões do jogo (só o código do jogo baixa)
        manualChunks: {
          three: ['three'],
          trystero: ['trystero'],
        },
      },
    },
  },
})
