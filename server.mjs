import { createServer } from 'http'
import { parse } from 'url'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import next from 'next'
import httpProxy from 'http-proxy'

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || '127.0.0.1'
const port = parseInt(process.env.PORT || '23000', 10)

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

const gatewayHost = process.env.TERMINAL_WS_HOST || '127.0.0.1'
const gatewayPort = parseInt(process.env.TERMINAL_WS_PORT || '23001', 10)
const embedGateway = process.env.AIMAESTRO_EMBED_GATEWAY !== '0'
const proxy = httpProxy.createProxyServer({
  target: `http://${gatewayHost}:${gatewayPort}`,
  ws: true,
  changeOrigin: true,
  autoRewrite: true,
  xfwd: true
})

proxy.on('error', (error, req, socket) => {
  console.error('Gateway proxy error:', error.message)
  if (socket && typeof socket.destroy === 'function') {
    socket.destroy()
  }
})

proxy.on('proxyReqWs', (_proxyReq, req) => {
  console.debug('[proxy] ws request → gateway', req.url)
})

app.prepare().then(() => {
  let gatewayProcess = null

  if (embedGateway) {
    const gatewayEnv = {
      ...process.env,
      TERMINAL_WS_HOST: gatewayHost,
      TERMINAL_WS_PORT: String(gatewayPort)
    }

    const gatewayEntry = new URL('./services/terminal-gateway/dist/index.js', import.meta.url).pathname
    if (!existsSync(gatewayEntry)) {
      console.warn(
        '[gateway] Build output not found at services/terminal-gateway/dist/index.js. Run "npm run gateway:build" to compile the gateway service.'
      )
    }

    gatewayProcess = spawn(process.execPath, [gatewayEntry], {
      env: gatewayEnv,
      stdio: 'inherit'
    })

    gatewayProcess.on('error', (error) => {
      console.error('[gateway] failed to start:', error)
    })

    gatewayProcess.on('exit', (code, signal) => {
      const reason = typeof code === 'number' ? `code ${code}` : signal ? `signal ${signal}` : 'unknown reason'
      console.log(`[gateway] process exited (${reason})`)
    })
  } else {
    console.log(
      `[gateway] External mode enabled. Expecting gateway on ws://${gatewayHost}:${gatewayPort}/term (set AIMAESTRO_EMBED_GATEWAY=1 to auto-launch).`
    )
  }

  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true)
      await handle(req, res, parsedUrl)
    } catch (err) {
      console.error('Error handling request:', err)
      res.statusCode = 500
      res.end('Internal server error')
    }
  })

  server.listen(port, hostname, () => {
    console.log(`> UI ready on http://${hostname}:${port}`)
    if (hostname === '0.0.0.0') {
      console.warn('⚠️ AI Maestro is listening on all network interfaces. Ensure this is intentional before exposing the port beyond localhost.')
    }
  })

  const handleUpgrade = app.getUpgradeHandler()

  server.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('/term')) {
      console.debug('[proxy] forwarding terminal upgrade', req.url)
      proxy.ws(req, socket, head)
      return
    }

    handleUpgrade(req, socket, head)
  })

  const shutdown = () => {
    server.close(() => {
      process.exit(0)
    })
    if (gatewayProcess && !gatewayProcess.killed) {
      gatewayProcess.kill()
    }
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
})
