import http from 'node:http'
import { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'

import { SessionManager } from './session/SessionManager'
import { validateOrigin } from './auth'
import { metrics } from './metrics'

function parseEnvInt(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

const port = parseEnvInt('TERMINAL_WS_PORT', 23001)
const host = process.env.TERMINAL_WS_HOST ?? '127.0.0.1'
const metricsToken = process.env.TERMINAL_METRICS_TOKEN ?? null
const activityToken = process.env.TERMINAL_ACTIVITY_TOKEN ?? metricsToken
const maxPayload = parseEnvInt('TERMINAL_MAX_PAYLOAD', 1 * 1024 * 1024)

const manager = new SessionManager()

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400)
    res.end('Bad Request')
    return
  }

  if (req.url.startsWith('/activity')) {
    if (activityToken) {
      const headerToken = req.headers['authorization']
      const token = headerToken?.startsWith('Bearer ')
        ? headerToken.slice('Bearer '.length)
        : null
      if (token !== activityToken) {
        res.writeHead(401)
        res.end('Unauthorized')
        return
      }
    }
    const snapshot = manager.activitySnapshot()
    res.setHeader('Content-Type', 'application/json')
    res.writeHead(200)
    res.end(JSON.stringify({ generatedAt: new Date().toISOString(), sessions: snapshot }))
    return
  }

  if (req.url.startsWith('/metrics')) {
    if (metricsToken) {
      const headerToken = req.headers['authorization']
      const token = headerToken?.startsWith('Bearer ')
        ? headerToken.slice('Bearer '.length)
        : null
      if (token !== metricsToken) {
        res.writeHead(401)
        res.end('Unauthorized')
        return
      }
    }

    try {
      const body = await metrics.render()
      res.setHeader('Content-Type', 'text/plain; version=0.0.4')
      res.writeHead(200)
      res.end(body)
    } catch (error) {
      console.error('Failed to render metrics:', error)
      res.writeHead(500)
      res.end('Metrics unavailable')
    }
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: true,
  maxPayload,
  handleProtocols: (protocols) => {
    return protocols.has('maestro.v1') ? 'maestro.v1' : false
  }
})

wss.on('connection', (ws, request) => {
  manager.handleConnection(ws, request)
})

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin
  const url = request.url
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'upgrade_attempt',
      origin,
      url,
      headers: request.headers
    })
  )

  if (!validateOrigin(request)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request)
  })
})

server.listen(port, host, () => {
  const address = server.address() as AddressInfo | null
  if (address) {
    console.log(`Terminal Gateway listening on ws://${address.address}:${address.port}/term`)
  } else {
    console.log(`Terminal Gateway listening on port ${port}`)
  }
})

const shutdown = () => {
  console.log('Shutting down Terminal Gateway...')
  manager.closeAll()
  wss.close(() => {
    server.close(() => process.exit(0))
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
