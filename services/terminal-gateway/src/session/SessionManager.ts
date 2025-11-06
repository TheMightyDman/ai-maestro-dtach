import type { IncomingMessage } from 'node:http'
import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import type { RawData } from 'ws'

import {
  AckSchema,
  ClientControlMessage,
  ClientControlMessageSchema,
  HelloSchema,
  InputSchema,
  JoinSchema,
  LeaderClaimSchema,
  PingSchema,
  PongSchema,
  ResizeSchema,
  ScrollSchema,
  SetLoggingSchema
} from '../protocol/schema'
import {
  dataDescriptor,
  error as errorMessage,
  historyBegin,
  historyEnd,
  leaderChange,
  ok as okMessage,
  ping as pingMessage,
  policy as policyMessage,
  scrollStatus,
  serialize,
  welcome as welcomeMessage
} from '../protocol/messages'
import { RingBuffer } from './RingBuffer'
import { PtySession } from './PtySession'
import { metrics } from '../metrics'
import { validateToken } from '../auth'
import { normalizeSessionName, runTmuxCommand } from '../tmux'
import { getSessionEngineClient } from '../../../lib/session-engine-client'

interface SessionManagerOptions {
  readonly ringBytes: number
  readonly highWater: number
  readonly lowWater: number
  readonly pingIntervalMs: number
  readonly pongTimeoutMs: number
  readonly historyChunkBytes: number
  readonly maxClientsPerSession: number
  readonly maxActiveConnectionsPerIp: number
  readonly maxConcurrentReplays: number
  readonly maxReplayBytes: number
}

const DEFAULT_OPTIONS: SessionManagerOptions = {
  ringBytes: parseEnvInt('TERMINAL_RING_BYTES', 32 * 1024 * 1024),
  highWater: parseEnvInt('TERMINAL_HIGH_WATER', 2 * 1024 * 1024),
  lowWater: parseEnvInt('TERMINAL_LOW_WATER', 512 * 1024),
  pingIntervalMs: 15_000,
  pongTimeoutMs: 30_000,
  historyChunkBytes: 64 * 1024,
  maxClientsPerSession: parseEnvInt('TERMINAL_MAX_CLIENTS_PER_SESSION', 4),
  maxActiveConnectionsPerIp: parseEnvInt('TERMINAL_MAX_ACTIVE_CONNECTIONS_PER_IP', 8),
  maxConcurrentReplays: parseEnvInt('TERMINAL_MAX_CONCURRENT_REPLAYS', 2),
  maxReplayBytes: parseEnvInt('TERMINAL_MAX_REPLAY_BYTES', 512 * 1024)
}

type ConnectionStage = 'await-hello' | 'await-join' | 'ready'

interface ConnectionContext {
  stage: ConnectionStage
  readonly ws: WebSocket
  readonly request: IncomingMessage
  readonly ipAddress: string
  session?: SessionState
  client?: ClientState
  tokenValidated: boolean
  pingTimer?: NodeJS.Timeout
  pongTimer?: NodeJS.Timeout
  lastPingTs?: number
}

interface ClientState {
  readonly id: string
  readonly ws: WebSocket
  readonly connection: ConnectionContext
  readonly session: SessionState
  sendSeq: number
  inFlightBytes: number
  pendingBytes: Map<number, number>
  historyComplete: boolean
  loggingEnabled: boolean
  isReplayOnly: boolean
  lastAckedSeq: number
  pendingLive: PendingSend[]
}

interface SessionState {
  readonly name: string
  readonly ring: RingBuffer
  pty: PtySession
  readonly clients: Map<string, ClientState>
  leaderId: string | null
  paused: boolean
  cleanupTimer?: NodeJS.Timeout | null
  lastActivity: number
  copyModeActive: boolean
  pendingScrollLines: number
  pendingScrollToBottom: boolean
  scrollFlushTimer?: NodeJS.Timeout | null
  scrollProcessing: boolean
  scrollOffset: number
  scrollLimit: number
}

interface PendingSend {
  readonly chunk: Buffer
}

function parseEnvInt(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

async function sessionExists(sessionName: string): Promise<boolean> {
  try {
    const client = getSessionEngineClient()
    await client.getMetadata(sessionName)
    return true
  } catch {
    return false
  }
}

async function capturePane(sessionName: string): Promise<Buffer> {
  const attempts: Array<{ args: string[]; timeoutMs: number }> = [
    { args: ['capture-pane', '-t', sessionName, '-p', '-S', '-1000', '-J', '-e'], timeoutMs: 3000 },
    { args: ['capture-pane', '-t', sessionName, '-p', '-J', '-e'], timeoutMs: 2000 },
    { args: ['capture-pane', '-t', sessionName, '-p', '-e'], timeoutMs: 2000 }
  ]

  let lastError: unknown = null

  for (const attempt of attempts) {
    try {
      const result = await runTmuxCommand(attempt.args, { allowCodes: [1], timeoutMs: attempt.timeoutMs })
      if (result.code === 1) {
        return Buffer.alloc(0)
      }
      return Buffer.from(result.stdout ?? '', 'utf8')
    } catch (error) {
      lastError = error
    }
  }

  if (lastError) {
    throw lastError
  }

  return Buffer.alloc(0)
}

export class SessionManager {
  private readonly options: SessionManagerOptions
  private readonly sessions = new Map<string, SessionState>()
  private readonly ipConnections = new Map<string, number>()
  private activeReplayCount = 0
  private readonly replayQueue: Array<{ session: SessionState; client: ClientState }> = []

  constructor(options: Partial<SessionManagerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  private acquireIpSlot(ipAddress: string): boolean {
    const current = this.ipConnections.get(ipAddress) ?? 0
    if (current >= this.options.maxActiveConnectionsPerIp) {
      return false
    }
    this.ipConnections.set(ipAddress, current + 1)
    return true
  }

  private releaseIpSlot(ipAddress: string): void {
    const current = this.ipConnections.get(ipAddress)
    if (typeof current !== 'number') {
      return
    }
    if (current <= 1) {
      this.ipConnections.delete(ipAddress)
    } else {
      this.ipConnections.set(ipAddress, current - 1)
    }
  }

  private log(event: string, attributes: Record<string, unknown> = {}): void {
    const entry = {
      ts: new Date().toISOString(),
      event,
      ...attributes
    }
    try {
      console.log(JSON.stringify(entry))
    } catch {
      console.log(`[gateway:${event}]`, attributes)
    }
  }

  private logError(event: string, attributes: Record<string, unknown> = {}): void {
    const entry = {
      ts: new Date().toISOString(),
      level: 'error',
      event,
      ...attributes
    }
    try {
      console.error(JSON.stringify(entry))
    } catch {
      console.error(`[gateway:${event}]`, attributes)
    }
  }

  handleConnection(ws: WebSocket, request: IncomingMessage): void {
    const ipAddress = request.socket?.remoteAddress ?? 'unknown'

    if (!this.acquireIpSlot(ipAddress)) {
      this.logError('ip_limit_exceeded', { ip: ipAddress })
      try {
        ws.send(serialize(errorMessage('Too many active connections from this IP', 'RATE_LIMIT')))
      } catch {}
      ws.close(1013, 'Too many connections')
      return
    }

    const ctx: ConnectionContext = {
      stage: 'await-hello',
      ws,
      request,
      ipAddress,
      tokenValidated: false
    }

    this.log('connection_open', {
      ip: ipAddress,
      headers: request.headers,
      url: request.url
    })

    ws.on('message', (data, isBinary) => {
      this.handleMessage(ctx, data, isBinary)
    })

    ws.on('close', () => {
      this.teardownConnection(ctx)
    })

    ws.on('error', () => {
      this.teardownConnection(ctx)
    })
  }

  private handleMessage(ctx: ConnectionContext, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.sendErrorAndClose(ctx, 'Binary client frames are unsupported')
      return
    }

    let parsed: ClientControlMessage
    try {
      const json = JSON.parse(data.toString())
      parsed = ClientControlMessageSchema.parse(json)
    } catch (error) {
      this.sendErrorAndClose(ctx, 'Invalid control message payload', error instanceof Error ? error.message : undefined)
      return
    }

    switch (parsed.type) {
      case 'hello':
        this.handleHello(ctx, parsed)
        break
      case 'join':
        this.handleJoin(ctx, parsed)
        break
      case 'ping':
        this.handleClientPing(ctx, parsed)
        break
      case 'pong':
        this.handleClientPong(ctx, parsed)
        break
      case 'resize':
        this.handleResize(ctx, parsed)
        break
      case 'scroll':
        this.handleScroll(ctx, parsed)
        break
      case 'leader-claim':
        this.handleLeaderClaim(ctx, parsed)
        break
      case 'set-logging':
        this.handleSetLogging(ctx, parsed)
        break
      case 'ack':
        this.handleAck(ctx, parsed)
        break
      case 'input':
        this.handleInput(ctx, parsed)
        break
      default:
        this.sendErrorAndClose(ctx, `Unhandled message type ${(parsed as ClientControlMessage).type}`)
    }
  }

  private handleHello(ctx: ConnectionContext, message: ClientControlMessage): void {
    if (ctx.stage !== 'await-hello') {
      this.sendErrorAndClose(ctx, 'Unexpected hello message')
      return
    }

    const parsed = HelloSchema.parse(message)
    if (parsed.version !== '1') {
      this.sendErrorAndClose(ctx, `Unsupported protocol version ${parsed.version}`)
      return
    }

    if (!validateToken(parsed.token)) {
      this.sendErrorAndClose(ctx, 'Unauthorized: invalid token', 'Check TERMINAL_WS_TOKEN configuration')
      return
    }

    ctx.tokenValidated = true
    ctx.stage = 'await-join'

    this.safeSend(ctx.ws, serialize(okMessage([
      'binary-data',
      'history-replay',
      'resize-leadership',
      'logging-toggle',
      'scroll-sync'
    ])))
  }

  private async handleJoin(ctx: ConnectionContext, message: ClientControlMessage) {
    if (ctx.stage !== 'await-join' || !ctx.tokenValidated) {
      this.sendErrorAndClose(ctx, 'Join attempted before successful hello handshake')
      return
    }

    const parsed = JoinSchema.parse(message)
    const normalized = normalizeSessionName(parsed.sessionName)
    if (!normalized) {
      this.sendErrorAndClose(ctx, 'Invalid session name')
      return
    }

    try {
      const exists = await sessionExists(normalized)
      if (!exists) {
        this.sendErrorAndClose(ctx, `Session "${normalized}" not found`, 'Refresh session list and try again')
        return
      }
    } catch (error) {
      this.sendErrorAndClose(ctx, 'Failed to verify tmux session', error instanceof Error ? error.message : undefined)
      return
    }

    const session = await this.getOrCreateSession(normalized)
    if (session.clients.size >= this.options.maxClientsPerSession) {
      this.sendErrorAndClose(ctx, 'Session is full', 'Too many viewers are attached right now')
      return
    }
    session.lastActivity = Date.now()

    const clientId = crypto.randomUUID?.() ?? `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const clientState: ClientState = {
      id: clientId,
      ws: ctx.ws,
      connection: ctx,
      session,
      sendSeq: 0,
      inFlightBytes: 0,
      pendingBytes: new Map(),
      historyComplete: false,
      loggingEnabled: true,
      isReplayOnly: false,
      lastAckedSeq: 0,
      pendingLive: []
    }

    session.clients.set(clientId, clientState)
    ctx.stage = 'ready'
    ctx.session = session
    ctx.client = clientState

    metrics.clientJoined(session.name)
    this.log('client_join', { session: session.name, clientId, ip: ctx.ipAddress })

    this.safeSend(ctx.ws, serialize(welcomeMessage(clientId)))
    this.clearCleanupTimer(session)
    this.maybeAssignLeader(session)
    this.beginHeartbeat(ctx)
    this.enqueueReplay(session, clientState)
    void this.updateScrollStatus(session, true)
  }

  private handleClientPing(ctx: ConnectionContext, message: ClientControlMessage) {
    if (ctx.stage !== 'ready') {
      return
    }
    const parsed = PingSchema.parse(message)
    this.safeSend(ctx.ws, serialize(pingMessage(parsed.ts)))
  }

  private handleClientPong(ctx: ConnectionContext, message: ClientControlMessage) {
    if (ctx.stage !== 'ready') {
      return
    }
    PongSchema.parse(message)
    if (ctx.pongTimer) {
      clearTimeout(ctx.pongTimer)
      ctx.pongTimer = undefined
    }
  }

  private handleResize(ctx: ConnectionContext, message: ClientControlMessage) {
    if (ctx.stage !== 'ready' || !ctx.client) {
      return
    }

    const parsed = ResizeSchema.parse(message)
    const session = ctx.client.session

    if (session.leaderId !== ctx.client.id) {
      return
    }

    session.pty.resize(parsed.cols, parsed.rows)
  }

  private handleScroll(ctx: ConnectionContext, message: ClientControlMessage) {
    if (ctx.stage !== 'ready' || !ctx.session) {
      return
    }

    const parsed = ScrollSchema.parse(message)
    if (parsed.lines === 0 && !parsed.atBottom) {
      return
    }

    const session = ctx.session
    if (parsed.lines !== 0) {
      session.pendingScrollLines += parsed.lines
    }
    if (parsed.atBottom) {
      session.pendingScrollToBottom = true
    }

    session.lastActivity = Date.now()

    this.scheduleScrollFlush(session)
  }

  private handleLeaderClaim(ctx: ConnectionContext, message: ClientControlMessage) {
    if (ctx.stage !== 'ready' || !ctx.client || !ctx.session) {
      return
    }

    LeaderClaimSchema.parse(message)
    this.assignLeader(ctx.session, ctx.client)
  }

  private handleSetLogging(ctx: ConnectionContext, message: ClientControlMessage) {
    if (ctx.stage !== 'ready' || !ctx.client) {
      return
    }

    const parsed = SetLoggingSchema.parse(message)
    ctx.client.loggingEnabled = parsed.enabled
    this.log('logging_toggle', {
      session: ctx.client.session.name,
      clientId: ctx.client.id,
      enabled: parsed.enabled
    })
  }

  private handleAck(ctx: ConnectionContext, message: ClientControlMessage) {
    if (ctx.stage !== 'ready' || !ctx.client) {
      return
    }

    const parsed = AckSchema.parse(message)
    const client = ctx.client

    if (parsed.upToSeq <= client.lastAckedSeq) {
      return
    }

    let releasedBytes = 0
    for (const [seq, size] of client.pendingBytes) {
      if (seq <= parsed.upToSeq) {
        releasedBytes += size
        client.pendingBytes.delete(seq)
      }
    }

    client.lastAckedSeq = parsed.upToSeq
    client.inFlightBytes = Math.max(0, client.inFlightBytes - releasedBytes)

    metrics.recordAckBytes(client.session.name, releasedBytes)
    this.log('ack', {
      session: client.session.name,
      clientId: client.id,
      seq: parsed.upToSeq,
      releasedBytes
    })
    this.evaluateBackpressure(client.session)
  }

  private handleInput(ctx: ConnectionContext, message: ClientControlMessage) {
    if (ctx.stage !== 'ready' || !ctx.client) {
      return
    }

    const parsed = InputSchema.parse(message)
    const buffer = Buffer.from(parsed.dataBase64, 'base64')
    ctx.client.session.pty.write(buffer)
  }

  private sendErrorAndClose(ctx: ConnectionContext, message: string, hint?: string) {
    this.logError('client_error', {
      session: ctx.session?.name,
      clientId: ctx.client?.id,
      message,
      hint
    })
    this.safeSend(ctx.ws, serialize(errorMessage(message, 'BAD_REQUEST', hint)))
    ctx.ws.close(1008, message)
  }

  private async getOrCreateSession(sessionName: string): Promise<SessionState> {
    let session = this.sessions.get(sessionName)
    if (session) {
      return session
    }

    const ring = new RingBuffer(this.options.ringBytes)
    const sessionState: SessionState = {
      name: sessionName,
      ring,
      clients: new Map(),
      leaderId: null,
      paused: false,
      pty: undefined as unknown as PtySession,
      cleanupTimer: null,
      lastActivity: Date.now(),
      copyModeActive: false,
      pendingScrollLines: 0,
      pendingScrollToBottom: false,
      scrollFlushTimer: null,
      scrollProcessing: false,
      scrollOffset: 0,
      scrollLimit: 0
    }

    const pty = await PtySession.create({
      sessionName,
      onData: (chunk) => {
        this.onPtyData(sessionState, chunk)
      },
      onExit: (exitCode, signal) => {
        this.handlePtyExit(sessionState, exitCode, signal)
      }
    })

    sessionState.pty = pty
    this.sessions.set(sessionName, sessionState)
    return sessionState
  }

  private handlePtyExit(session: SessionState, exitCode: number | null, signal: number | null) {
    this.sessions.delete(session.name)
    session.ring.clear()
    this.log('session_exit', {
      session: session.name,
      exitCode,
      signal
    })

    session.clients.forEach((client) => {
      this.safeSend(client.ws, serialize(errorMessage(`Session "${session.name}" closed`, 'SESSION_CLOSED')))
      client.ws.close(1011, 'Session ended')
    })
    session.clients.clear()
  }

  private onPtyData(session: SessionState, chunk: Buffer) {
    if (chunk.length === 0) {
      return
    }

    session.lastActivity = Date.now()
    session.ring.append(chunk)
    metrics.recordBytesOut(session.name, chunk.length)

    const liveChunk: PendingSend = { chunk }

    session.clients.forEach((client) => {
      if (!client.historyComplete) {
        client.pendingLive.push(liveChunk)
        return
      }
      this.sendLiveChunk(client, liveChunk)
    })

    if (session.scrollOffset > 0) {
      void this.updateScrollStatus(session)
    }
  }

  private sendLiveChunk(client: ClientState, payload: PendingSend) {
    const { ws, session } = client
    if (ws.readyState !== WebSocket.OPEN) {
      return
    }

    const seq = ++client.sendSeq
    const size = payload.chunk.length
    client.pendingBytes.set(seq, size)
    client.inFlightBytes += size

    this.safeSend(ws, serialize(dataDescriptor(seq, size, 'live')))
    ws.send(payload.chunk, { binary: true }, (error) => {
      if (error) {
        this.logError('binary_send_failed', {
          session: session.name,
          clientId: client.id,
          error: error.message
        })
        ws.close(1011, 'Binary send failure')
      }
    })

    this.evaluateBackpressure(session)
  }

  private enqueueReplay(session: SessionState, client: ClientState) {
    if (client.historyComplete || client.ws.readyState !== WebSocket.OPEN) {
      return
    }
    if (this.activeReplayCount >= this.options.maxConcurrentReplays) {
      const position = this.replayQueue.push({ session, client })
      metrics.setReplayQueueLength(this.replayQueue.length)
      this.log('history_replay_queued', {
        session: session.name,
        clientId: client.id,
        position
      })
      this.safeSend(client.ws, serialize(policyMessage('replay-only', 'History replay queued on gateway')))
      return
    }
    this.startReplay(session, client)
  }

  private startReplay(session: SessionState, client: ClientState) {
    if (client.ws.readyState !== WebSocket.OPEN) {
      return
    }
    this.activeReplayCount += 1
    metrics.setActiveReplayCount(this.activeReplayCount)
    this.log('history_replay_start', {
      session: session.name,
      clientId: client.id,
      active: this.activeReplayCount
    })

    client.isReplayOnly = true
    this.safeSend(client.ws, serialize(policyMessage('replay-only', 'History replay in progress')))

    this.replayHistory(session, client)
      .catch((error) => {
        this.logError('history_replay_failed', {
          session: session.name,
          clientId: client.id,
          error: error instanceof Error ? error.message : String(error)
        })
        this.safeSend(client.ws, serialize(errorMessage('Failed to replay terminal history', 'HISTORY_ERROR')))
        client.historyComplete = true
      })
      .finally(() => {
        client.isReplayOnly = false
        this.activeReplayCount = Math.max(0, this.activeReplayCount - 1)
        metrics.setActiveReplayCount(this.activeReplayCount)
        if (client.ws.readyState === WebSocket.OPEN) {
          this.safeSend(client.ws, serialize(policyMessage('normal', 'History replay complete')))
        }
        this.processReplayQueue()
      })
  }

  private removeFromReplayQueue(clientId: string) {
    const index = this.replayQueue.findIndex((entry) => entry.client.id === clientId)
    if (index >= 0) {
      const [removed] = this.replayQueue.splice(index, 1)
      metrics.setReplayQueueLength(this.replayQueue.length)
      this.log('history_replay_cancelled', {
        session: removed.session.name,
        clientId,
        remaining: this.replayQueue.length
      })
    }
  }

  private processReplayQueue() {
    if (this.activeReplayCount >= this.options.maxConcurrentReplays) {
      return
    }

    while (this.replayQueue.length > 0 && this.activeReplayCount < this.options.maxConcurrentReplays) {
      const next = this.replayQueue.shift()
      metrics.setReplayQueueLength(this.replayQueue.length)
      if (!next) {
        break
      }
      if (next.client.ws.readyState !== WebSocket.OPEN) {
        continue
      }
      this.log('history_replay_dequeued', {
        session: next.session.name,
        clientId: next.client.id,
        remaining: this.replayQueue.length
      })
      this.startReplay(next.session, next.client)
      break
    }
  }

  private async replayHistory(session: SessionState, client: ClientState) {
    const snapshot = session.ring.snapshot()
    const { ws } = client

    if (snapshot.byteLength === 0) {
      client.historyComplete = true
      return
    }
    const maxReplayBytes = this.options.maxReplayBytes
    const totalBytes = maxReplayBytes > 0 ? Math.min(snapshot.byteLength, maxReplayBytes) : snapshot.byteLength
    const trimmedBytes = snapshot.byteLength - totalBytes
    const replayBuffer = trimmedBytes > 0 ? snapshot.data.subarray(trimmedBytes) : snapshot.data

    if (trimmedBytes > 0) {
      this.log('history_replay_trimmed', {
        session: session.name,
        clientId: client.id,
        originalBytes: snapshot.byteLength,
        replayBytes: totalBytes,
        trimmedBytes
      })
    }

    if (ws.readyState !== WebSocket.OPEN) {
      client.historyComplete = true
      return
    }

    this.safeSend(ws, serialize(historyBegin(totalBytes)))

    const chunkSize = this.options.historyChunkBytes
    let offset = 0
    while (offset < totalBytes) {
      if (ws.readyState !== WebSocket.OPEN) {
        this.log('history_replay_aborted', {
          session: session.name,
          clientId: client.id,
          offset,
          totalBytes
        })
        client.historyComplete = true
        return
      }

      const end = Math.min(totalBytes, offset + chunkSize)
      const slice = replayBuffer.subarray(offset, end)
      const seq = ++client.sendSeq
      const length = slice.length
      client.pendingBytes.set(seq, length)
      client.inFlightBytes += length
      this.safeSend(ws, serialize(dataDescriptor(seq, length, 'history')))
      ws.send(slice, { binary: true }, (error) => {
        if (error) {
          this.logError('binary_history_send_failed', {
            session: session.name,
            clientId: client.id,
            error: error.message
          })
          ws.close(1011, 'History send failure')
        }
      })
      offset = end
      metrics.recordReplayBytes(session.name, length)
      this.evaluateBackpressure(session)

      while (ws.bufferedAmount > this.options.highWater && ws.readyState === WebSocket.OPEN) {
        await delay(10)
      }
    }

    if (ws.readyState === WebSocket.OPEN) {
      this.safeSend(ws, serialize(historyEnd()))
    }
    client.historyComplete = true
    if (client.pendingLive.length > 0) {
      const pending = [...client.pendingLive]
      client.pendingLive.length = 0
      pending.forEach((payload) => this.sendLiveChunk(client, payload))
    }
    this.evaluateBackpressure(session)
  }

  private evaluateBackpressure(session: SessionState) {
    const shouldPause = Array.from(session.clients.values()).some((client) => {
      if (client.ws.readyState !== WebSocket.OPEN) {
        return false
      }
      const buffered = client.ws.bufferedAmount + client.inFlightBytes
      return buffered >= this.options.highWater
    })

    if (shouldPause && !session.paused) {
      session.paused = true
      session.pty.pause()
      metrics.recordPtyPause(session.name)
      this.log('pty_pause', { session: session.name })
    } else if (session.paused) {
      const shouldResume = Array.from(session.clients.values()).every((client) => {
        if (client.ws.readyState !== WebSocket.OPEN) {
          return true
        }
        const buffered = client.ws.bufferedAmount + client.inFlightBytes
        return buffered <= this.options.lowWater
      })
      if (shouldResume) {
        session.paused = false
        session.pty.resume()
        metrics.recordPtyResume(session.name)
        this.log('pty_resume', { session: session.name })
      }
    }
  }

  private beginHeartbeat(ctx: ConnectionContext) {
    const interval = this.options.pingIntervalMs
    const timeout = this.options.pongTimeoutMs

    const sendPing = () => {
      if (ctx.ws.readyState !== WebSocket.OPEN) {
        return
      }

      const ts = Date.now()
      ctx.lastPingTs = ts
      this.safeSend(ctx.ws, serialize(pingMessage(ts)))

      ctx.pongTimer = setTimeout(() => {
        ctx.ws.close(4000, 'Heartbeat timeout')
      }, timeout)
    }

    ctx.pingTimer = setInterval(sendPing, interval)
    sendPing()
  }

  private assignLeader(session: SessionState, client: ClientState) {
    if (session.leaderId === client.id) {
      return
    }

    session.leaderId = client.id
    this.broadcast(session, leaderChange(client.id))
  }

  private maybeAssignLeader(session: SessionState) {
    if (session.leaderId && session.clients.has(session.leaderId)) {
      return
    }
    const firstClient = session.clients.values().next().value as ClientState | undefined
    session.leaderId = firstClient?.id ?? null
    this.broadcast(session, leaderChange(session.leaderId))
  }

  private scheduleScrollFlush(session: SessionState): void {
    if ((session.pendingScrollLines === 0 && !session.pendingScrollToBottom) || session.scrollProcessing) {
      return
    }
    if (session.scrollFlushTimer) {
      return
    }
    session.scrollFlushTimer = setTimeout(() => {
      session.scrollFlushTimer = null
      void this.flushScroll(session)
    }, 25)
  }

  private async flushScroll(session: SessionState): Promise<void> {
    if (session.scrollProcessing) {
      return
    }

    session.scrollProcessing = true
    try {
      while (session.pendingScrollLines !== 0 || session.pendingScrollToBottom) {
        const delta = session.pendingScrollLines
        const toBottom = session.pendingScrollToBottom
        session.pendingScrollLines = 0
        session.pendingScrollToBottom = false

        if (delta !== 0) {
          await this.applyScrollDelta(session, delta)
        }

        if (toBottom) {
          await this.exitCopyMode(session)
        }
      }
      await this.updateScrollStatus(session)
    } catch (error) {
      this.logError('scroll_flush_failed', {
        session: session.name,
        error: error instanceof Error ? error.message : error
      })
    } finally {
      session.scrollProcessing = false
      if (session.pendingScrollLines !== 0 || session.pendingScrollToBottom) {
        this.scheduleScrollFlush(session)
      }
    }
  }

  private async applyScrollDelta(session: SessionState, delta: number): Promise<void> {
    const lines = Math.trunc(delta)
    if (lines === 0) {
      return
    }

    if (lines < 0) {
      const ready = await this.ensureCopyMode(session)
      if (!ready) {
        return
      }
    } else if (!session.copyModeActive) {
      return
    }

    const direction = lines < 0 ? 'scroll-up' : 'scroll-down'
    let remaining = Math.abs(lines)
    const maxPerCommand = 200

    while (remaining > 0) {
      const batch = Math.min(maxPerCommand, remaining)
      remaining -= batch
      try {
        await runTmuxCommand(['send-keys', '-t', session.name, '-X', '-N', String(batch), direction], { timeoutMs: 1500 })
        session.lastActivity = Date.now()
      } catch (error) {
        this.logError('scroll_command_failed', {
          session: session.name,
          direction,
          batch,
          error: error instanceof Error ? error.message : error
        })
        break
      }
    }
  }

  private async ensureCopyMode(session: SessionState): Promise<boolean> {
    if (session.copyModeActive) {
      return true
    }
    try {
      const result = await runTmuxCommand(['copy-mode', '-t', session.name], { timeoutMs: 1500 })
      if (result.code === 0) {
        session.copyModeActive = true
        return true
      }
      this.logError('copy_mode_failed', {
        session: session.name,
        code: result.code,
        stderr: result.stderr
      })
    } catch (error) {
      this.logError('copy_mode_failed', {
        session: session.name,
        error: error instanceof Error ? error.message : error
      })
    }
    return false
  }

  private async exitCopyMode(session: SessionState): Promise<void> {
    try {
      await runTmuxCommand(['send-keys', '-t', session.name, '-X', 'cancel'], { timeoutMs: 1500 })
    } catch (error) {
      this.logError('copy_mode_exit_failed', {
        session: session.name,
        error: error instanceof Error ? error.message : error
      })
    } finally {
      session.copyModeActive = false
    }
  }

  private async getScrollMetrics(session: SessionState): Promise<{ offset: number; limit: number } | null> {
    try {
      const result = await runTmuxCommand(
        ['display-message', '-p', '-t', session.name, '#{scroll_position} #{history_size}'],
        { timeoutMs: 1000 }
      )
      const raw = (result.stdout ?? '').trim()
      if (!raw) {
        return null
      }
      const [offsetRaw, limitRaw] = raw.split(/\s+/, 2)
      const parsedOffset = Number.parseInt(offsetRaw ?? '0', 10)
      const parsedLimit = Number.parseInt(limitRaw ?? '0', 10)
      const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0
      const limitCandidate = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 0
      const limit = Math.max(limitCandidate, offset)
      return { offset, limit }
    } catch (error) {
      this.logError('scroll_metrics_failed', {
        session: session.name,
        error: error instanceof Error ? error.message : error
      })
      return null
    }
  }

  private async updateScrollStatus(session: SessionState, force = false): Promise<void> {
    const metrics = await this.getScrollMetrics(session)
    if (!metrics) {
      return
    }
    const { offset, limit } = metrics
    const changed = force || offset !== session.scrollOffset || limit !== session.scrollLimit
    session.scrollOffset = offset
    session.scrollLimit = limit
    if (changed) {
      this.broadcast(session, scrollStatus(offset, limit))
    }
  }

  private broadcast(session: SessionState, message: unknown) {
    const payload = serialize(message)
    session.clients.forEach((client) => this.safeSend(client.ws, payload))
  }

  private clearCleanupTimer(session: SessionState) {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer)
      session.cleanupTimer = null
    }
  }

  private teardownConnection(ctx: ConnectionContext) {
    if (ctx.pingTimer) {
      clearInterval(ctx.pingTimer)
      ctx.pingTimer = undefined
    }
    if (ctx.pongTimer) {
      clearTimeout(ctx.pongTimer)
      ctx.pongTimer = undefined
    }

    if (ctx.client && ctx.session) {
      const { session, client } = ctx
      session.clients.delete(client.id)
      metrics.clientLeft(session.name)
      this.log('client_leave', { session: session.name, clientId: client.id })
      this.removeFromReplayQueue(client.id)

      if (session.clients.size === 0) {
        session.cleanupTimer = setTimeout(() => {
          this.log('session_cleanup_execute', { session: session.name })
          this.sessions.delete(session.name)
          if (session.scrollFlushTimer) {
            clearTimeout(session.scrollFlushTimer)
            session.scrollFlushTimer = null
          }
          session.scrollProcessing = false
          session.pendingScrollLines = 0
          session.pendingScrollToBottom = false
          session.pty.dispose()
          session.ring.clear()
        }, 30_000)
        this.log('session_cleanup_scheduled', { session: session.name, delayMs: 30_000 })
      } else {
        if (session.leaderId === client.id) {
          session.leaderId = null
          this.maybeAssignLeader(session)
        }
        this.evaluateBackpressure(session)
      }
      this.processReplayQueue()
    }

    ctx.session = undefined
    ctx.client = undefined
    this.releaseIpSlot(ctx.ipAddress)
  }

  private safeSend(ws: WebSocket, payload: string) {
    if (ws.readyState !== WebSocket.OPEN) {
      return
    }
    try {
      ws.send(payload)
    } catch (error) {
      this.logError('control_send_failed', {
        error: error instanceof Error ? error.message : String(error)
      })
      try {
        ws.close(1011, 'Send failure')
      } catch {
        // ignore
      }
    }
  }

  closeAll(): void {
    this.sessions.forEach((session) => {
      session.clients.forEach((client) => client.ws.close(1001, 'Server shutting down'))
      if (session.cleanupTimer) {
        clearTimeout(session.cleanupTimer)
        session.cleanupTimer = null
      }
      if (session.scrollFlushTimer) {
        clearTimeout(session.scrollFlushTimer)
        session.scrollFlushTimer = null
      }
      session.scrollProcessing = false
      session.pendingScrollLines = 0
      session.pendingScrollToBottom = false
      session.pty.dispose()
      session.ring.clear()
    })
    this.sessions.clear()
  }

  activitySnapshot(): Array<{ session: string; lastActivity: number }> {
    return Array.from(this.sessions.values()).map((session) => ({
      session: session.name,
      lastActivity: session.lastActivity
    }))
  }
}
