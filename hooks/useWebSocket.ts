'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WebSocketStatus } from '@/types/websocket'

const WS_MAX_RECONNECT_ATTEMPTS = 5
const WS_BACKOFF_MS = [500, 1000, 2000, 4000, 8000]

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: false })

const TERMINAL_DEBUG = process.env.NODE_ENV === 'development' || process.env.NEXT_PUBLIC_TERMINAL_DEBUG === 'true'

const debugLog = (...args: unknown[]) => {
  if (TERMINAL_DEBUG) {
    console.debug('[useWebSocket]', ...args)
  }
}

export type TerminalDataSource = 'history' | 'live'

export interface TerminalDataPacket {
  seq: number
  data: string
  source: TerminalDataSource
}

interface UseWebSocketOptions {
  sessionId: string
  onData?: (packet: TerminalDataPacket) => void
  onHistoryEvent?: (event: 'begin' | 'end', bytes?: number) => void
  onLeaderChange?: (clientId: string | null) => void
  onPolicy?: (mode: 'normal' | 'replay-only', reason?: string) => void
  onError?: (error: Event) => void
  onOpen?: () => void
  onClose?: () => void
  enabled?: boolean
  onScrollStatus?: (metrics: { offset: number; limit: number }) => void
}

interface PendingBinaryDescriptor {
  seq: number
  size: number
  source: TerminalDataSource
}

type ConnectionPhase = 'idle' | 'connecting' | 'handshake' | 'history' | 'ready' | 'error'

const resolveGatewayUrl = () => {
  const envUrl = process.env.NEXT_PUBLIC_TERMINAL_WS_URL
  if (envUrl) {
    return envUrl.endsWith('/term') ? envUrl : `${envUrl.replace(/\/$/, '')}/term`
  }

  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}/term`
  }

  const protocol = process.env.NODE_ENV === 'production' ? 'wss:' : 'ws:'
  const fallbackHost = process.env.HOSTNAME || '127.0.0.1'
  const fallbackPort = process.env.PORT || '23000'
  return `${protocol}//${fallbackHost}:${fallbackPort}/term`
}

const TERMINAL_WS_URL = resolveGatewayUrl()
const CLIENT_TOKEN = process.env.NEXT_PUBLIC_TERMINAL_WS_TOKEN

const base64From = (input: string | Uint8Array): string => {
  const bytes = typeof input === 'string' ? textEncoder.encode(input) : input
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  if (typeof btoa === 'function') {
    return btoa(binary)
  }
  return Buffer.from(binary, 'binary').toString('base64')
}

const stringFromBase64 = (value: string): string => {
  let binary: string
  if (typeof atob === 'function') {
    binary = atob(value)
  } else {
    binary = Buffer.from(value, 'base64').toString('binary')
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return textDecoder.decode(bytes)
}

export function useWebSocket(options: UseWebSocketOptions) {
  const {
    sessionId,
    onData,
    onHistoryEvent,
    onLeaderChange,
    onPolicy,
    onError,
    onOpen,
    onClose,
    enabled = true,
    onScrollStatus
  } = options
  const [status, setStatus] = useState<WebSocketStatus>('disconnected')
  const [phase, setPhase] = useState<ConnectionPhase>('idle')
  const [isConnected, setIsConnected] = useState(false)
  const [connectionError, setConnectionError] = useState<Error | null>(null)
  const [errorHint, setErrorHint] = useState<string | null>(null)
  const [clientId, setClientId] = useState<string | null>(null)
  const [leaderId, setLeaderId] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null)
  const expectedBinaryRef = useRef<PendingBinaryDescriptor | null>(null)
  const latestSeqRef = useRef(0)
  const acknowledgedSeqRef = useRef(0)
  const connectionStatusRef = useRef<'idle' | 'connecting' | 'open' | 'closing'>('idle')
  const phaseRef = useRef<ConnectionPhase>('idle')
  const activeConnectionIdRef = useRef(0)
  const shouldReconnectRef = useRef(true)
  const connectRef = useRef<() => void>(() => {})
  const sessionIdRef = useRef(sessionId)
  const connectionErrorRef = useRef<Error | null>(null)
  const errorHintRef = useRef<string | null>(null)
  const handshakeReadyTimerRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  const onDataRef = useRef(onData)
  useEffect(() => {
    onDataRef.current = onData
  }, [onData])

  const onHistoryEventRef = useRef(onHistoryEvent)
  useEffect(() => {
    onHistoryEventRef.current = onHistoryEvent
  }, [onHistoryEvent])

  const onLeaderChangeRef = useRef(onLeaderChange)
  useEffect(() => {
    onLeaderChangeRef.current = onLeaderChange
  }, [onLeaderChange])

  const onPolicyRef = useRef(onPolicy)
  useEffect(() => {
    onPolicyRef.current = onPolicy
  }, [onPolicy])

  const onScrollStatusRef = useRef(onScrollStatus)
  useEffect(() => {
    onScrollStatusRef.current = onScrollStatus
  }, [onScrollStatus])

  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  const onOpenRef = useRef(onOpen)
  useEffect(() => {
    onOpenRef.current = onOpen
  }, [onOpen])

  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  const setStatusSafe = useCallback((next: WebSocketStatus) => {
    setStatus((prev) => (prev === next ? prev : next))
  }, [])

  const setPhaseSafe = useCallback((next: ConnectionPhase) => {
    if (phaseRef.current === next) {
      return
    }
    phaseRef.current = next
    setPhase(next)
  }, [])

  const setIsConnectedSafe = useCallback((value: boolean) => {
    setIsConnected((prev) => (prev === value ? prev : value))
  }, [])

  const setConnectionErrorSafe = useCallback((error: Error | null) => {
    if (connectionErrorRef.current?.message === error?.message) {
      return
    }
    connectionErrorRef.current = error
    setConnectionError(error)
  }, [])

  const setErrorHintSafe = useCallback((hint: string | null) => {
    if (errorHintRef.current === hint) {
      return
    }
    errorHintRef.current = hint
    setErrorHint(hint)
  }, [])

  const clearSocket = useCallback(() => {
    if (wsRef.current) {
      try {
        wsRef.current.close()
      } catch {}
      wsRef.current = null
    }
    expectedBinaryRef.current = null
  }, [])

  const clearHandshakeTimer = useCallback(() => {
    if (handshakeReadyTimerRef.current) {
      clearTimeout(handshakeReadyTimerRef.current)
      handshakeReadyTimerRef.current = null
    }
  }, [])

  const scheduleReconnect = useCallback(() => {
    if (!shouldReconnectRef.current) {
      debugLog('reconnect:skipped', { sessionId: sessionIdRef.current, reason: 'disabled' })
      return
    }

    if (connectionStatusRef.current === 'connecting' || connectionStatusRef.current === 'open') {
      debugLog('reconnect:skipped', {
        sessionId: sessionIdRef.current,
        reason: 'socket-active',
        status: connectionStatusRef.current
      })
      return
    }

    const attempt = reconnectAttemptsRef.current
    if (attempt >= WS_MAX_RECONNECT_ATTEMPTS) {
      shouldReconnectRef.current = false
      setConnectionErrorSafe(new Error('Failed to reconnect after multiple attempts'))
      setErrorHintSafe(null)
      setStatusSafe('error')
      setPhaseSafe('error')
      return
    }

    const delay = WS_BACKOFF_MS[Math.min(attempt, WS_BACKOFF_MS.length - 1)]
    reconnectAttemptsRef.current = attempt + 1
    clearReconnectTimer()
    reconnectTimerRef.current = setTimeout(() => {
      if (!shouldReconnectRef.current) {
        return
      }
      debugLog('reconnect:attempt', {
        sessionId: sessionIdRef.current,
        attempt: reconnectAttemptsRef.current,
        delay
      })
      const nextConnect = connectRef.current
      if (nextConnect) {
        nextConnect()
      }
    }, delay)
  }, [clearReconnectTimer, setConnectionErrorSafe, setErrorHintSafe, setPhaseSafe, setStatusSafe])

  const closeEventHint = useCallback((event: CloseEvent): string | null => {
    if (event.code === 1000) {
      return null
    }
    switch (event.code) {
      case 1008:
        return 'Gateway rejected the request. Confirm TERMINAL_WS_TOKEN and session permissions.'
      case 1011:
        return 'Gateway hit an internal error. Check services/terminal-gateway logs.'
      case 4000:
        return 'Gateway heartbeat timed out. Ensure the session engine and dtach session are still running.'
      case 1006:
        return 'Network connection dropped. Verify reverse proxy/WebSocket settings.'
      default:
        break
    }
    if (!event.wasClean) {
      return 'Connection closed unexpectedly. Check the gateway and your network link.'
    }
    return null
  }, [])

  const handleControlMessage = useCallback((message: unknown) => {
    if (!message || typeof message !== 'object') {
      return
    }

    const payload = message as Record<string, unknown>
    switch (payload.type) {
      case 'error': {
        const err = new Error(String(payload.message ?? 'Gateway error'))
        setConnectionErrorSafe(err)
        setErrorHintSafe(typeof payload.hint === 'string' ? payload.hint : null)
        setPhaseSafe('error')
        clearHandshakeTimer()
        return
      }
      case 'ok':
        setConnectionErrorSafe(null)
        setErrorHintSafe(null)
        if (phaseRef.current === 'idle') {
          setPhaseSafe('handshake')
        }
        return
      case 'welcome':
        if (typeof payload.clientId === 'string') {
          const nextClientId = payload.clientId
          setClientId((prev) => (prev === nextClientId ? prev : nextClientId))
        }
        setPhaseSafe('handshake')
        clearHandshakeTimer()
        handshakeReadyTimerRef.current = setTimeout(() => {
          if (phaseRef.current === 'handshake') {
            setPhaseSafe('ready')
          }
        }, 250)
        return
      case 'history-begin':
        clearHandshakeTimer()
        setPhaseSafe('history')
        onHistoryEventRef.current?.('begin', typeof payload.bytes === 'number' ? payload.bytes : undefined)
        return
      case 'history-chunk':
        if (typeof payload.seq === 'number' && typeof payload.dataBase64 === 'string') {
          latestSeqRef.current = Math.max(latestSeqRef.current, payload.seq)
          onDataRef.current?.({ seq: payload.seq, data: stringFromBase64(payload.dataBase64), source: 'history' })
        }
        return
      case 'history-end':
        clearHandshakeTimer()
        onHistoryEventRef.current?.('end')
        setPhaseSafe('ready')
        return
      case 'data':
        if (typeof payload.seq === 'number' && typeof payload.size === 'number') {
          const source: TerminalDataSource = payload.source === 'history' ? 'history' : 'live'
          expectedBinaryRef.current = { seq: payload.seq, size: payload.size, source }
          if (source === 'live') {
            setPhaseSafe('ready')
          }
        }
        return
      case 'leader-change':
        if (payload.clientId === null || typeof payload.clientId === 'string') {
          const nextLeaderId = payload.clientId as string | null
          setLeaderId((prev) => (prev === nextLeaderId ? prev : nextLeaderId))
          onLeaderChangeRef.current?.(nextLeaderId)
        }
        if (phaseRef.current !== 'ready') {
          setPhaseSafe('ready')
        }
        return
      case 'policy':
        if (payload.mode === 'normal' || payload.mode === 'replay-only') {
          onPolicyRef.current?.(payload.mode, typeof payload.reason === 'string' ? payload.reason : undefined)
        }
        if (phaseRef.current !== 'ready') {
          setPhaseSafe('ready')
        }
        return
      case 'scroll-status': {
        const offset = typeof payload.offset === 'number' ? Math.max(0, Math.trunc(payload.offset)) : 0
        const limit = typeof payload.limit === 'number' ? Math.max(0, Math.trunc(payload.limit)) : 0
        onScrollStatusRef.current?.({ offset, limit })
        if (phaseRef.current !== 'ready') {
          setPhaseSafe('ready')
        }
        return
      }
      case 'ping':
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'pong', ts: payload.ts ?? Date.now() }))
        }
        if (phaseRef.current !== 'ready') {
          setPhaseSafe('ready')
        }
        clearHandshakeTimer()
        return
      case 'pong':
        if (phaseRef.current !== 'ready') {
          setPhaseSafe('ready')
        }
        clearHandshakeTimer()
        return
      default:
        return
    }
  }, [clearHandshakeTimer, setConnectionErrorSafe, setErrorHintSafe, setPhaseSafe])

  const connect = useCallback(() => {
    if (!shouldReconnectRef.current) {
      debugLog('connect:skipped', { sessionId, reason: 'disabled' })
      return
    }

    if (connectionStatusRef.current === 'connecting' || connectionStatusRef.current === 'open') {
      debugLog('connect:skipped', { sessionId, status: connectionStatusRef.current })
      return
    }

    debugLog('connect:start', { sessionId, url: TERMINAL_WS_URL })
    clearReconnectTimer()
    clearSocket()

    connectionStatusRef.current = 'connecting'
    setStatusSafe('connecting')
    setPhaseSafe('connecting')
    setIsConnectedSafe(false)
    setConnectionErrorSafe(null)
    setErrorHintSafe(null)
    setClientId((prev) => (prev === null ? prev : null))
    setLeaderId((prev) => (prev === null ? prev : null))
    expectedBinaryRef.current = null
    latestSeqRef.current = 0
    acknowledgedSeqRef.current = 0

    const connectionId = ++activeConnectionIdRef.current
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now()

    try {
      const ws = new WebSocket(TERMINAL_WS_URL, 'maestro.v1')
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        if (connectionId !== activeConnectionIdRef.current || ws !== wsRef.current) {
          ws.close()
          return
        }

        connectionStatusRef.current = 'open'
        reconnectAttemptsRef.current = 0
        setStatusSafe('connected')
        setPhaseSafe('handshake')
        setIsConnectedSafe(true)
        setConnectionErrorSafe(null)
        setErrorHintSafe(null)

        debugLog('open', {
          sessionId,
          durationMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start)
        })

        onOpenRef.current?.()

        const helloMessage = {
          type: 'hello',
          version: '1',
          ...(CLIENT_TOKEN ? { token: CLIENT_TOKEN } : {})
        }

        try {
          ws.send(JSON.stringify(helloMessage))
          ws.send(JSON.stringify({ type: 'join', sessionName: sessionId }))
        } catch (error) {
          debugLog('send_failed', { sessionId, error })
        }
      }

      ws.onmessage = (event) => {
        if (connectionId !== activeConnectionIdRef.current) {
          return
        }
        debugLog('message', { sessionId, type: typeof event.data })

        if (typeof event.data === 'string') {
          try {
            const json = JSON.parse(event.data)
            handleControlMessage(json)
          } catch (error) {
            debugLog('message:non-json', { sessionId, error })
          }
          return
        }

        if (event.data instanceof ArrayBuffer) {
          const descriptor = expectedBinaryRef.current
          expectedBinaryRef.current = null
          if (!descriptor) {
            return
          }
          latestSeqRef.current = Math.max(latestSeqRef.current, descriptor.seq)
          const chunk = new Uint8Array(event.data)
          const content = textDecoder.decode(chunk)
          onDataRef.current?.({ seq: descriptor.seq, data: content, source: descriptor.source })
          if (descriptor.source === 'live') {
            setPhaseSafe('ready')
          }
          clearHandshakeTimer()
        }
      }

      ws.onerror = (event) => {
        if (connectionId !== activeConnectionIdRef.current) {
          return
        }
        debugLog('error', { sessionId, event })
        setStatusSafe('error')
        setPhaseSafe('error')
        clearHandshakeTimer()
        if (!connectionErrorRef.current) {
          setConnectionErrorSafe(new Error('WebSocket encountered an error'))
        }
        setErrorHintSafe('Network error while streaming terminal data. Check your network link and gateway logs.')
        onErrorRef.current?.(event)
      }

      ws.onclose = (event) => {
        if (connectionId !== activeConnectionIdRef.current) {
          return
        }

        wsRef.current = null
        connectionStatusRef.current = 'idle'
        setIsConnectedSafe(false)
        setStatusSafe('disconnected')
        if (phaseRef.current !== 'error') {
          setPhaseSafe('idle')
        }
        setLeaderId((prev) => (prev === null ? prev : null))
        expectedBinaryRef.current = null
        clearHandshakeTimer()
        onCloseRef.current?.()

        const derivedHint = closeEventHint(event)
        if (derivedHint) {
          setErrorHintSafe(derivedHint)
        }
        if (!connectionErrorRef.current) {
          const reason = event.reason && event.reason.trim().length > 0 ? event.reason : undefined
          const message = reason ?? (event.wasClean ? 'Connection closed by gateway' : 'Connection closed unexpectedly')
          setConnectionErrorSafe(new Error(message))
        }

        if (shouldReconnectRef.current) {
          debugLog('close', { sessionId })
          scheduleReconnect()
        }
      }

      wsRef.current = ws
    } catch (error) {
      connectionStatusRef.current = 'idle'
      wsRef.current = null
      debugLog('connect_failed', { sessionId, error })
      setStatusSafe('error')
      setPhaseSafe('error')
      setConnectionErrorSafe(error instanceof Error ? error : new Error('WebSocket connection failed'))
      setErrorHintSafe('Unable to open WebSocket. Ensure services/terminal-gateway is running and reachable.')
      scheduleReconnect()
      return
    }
  }, [clearHandshakeTimer, clearReconnectTimer, clearSocket, closeEventHint, handleControlMessage, scheduleReconnect, sessionId, setConnectionErrorSafe, setErrorHintSafe, setIsConnectedSafe, setPhaseSafe, setStatusSafe])

  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  useEffect(() => {
    const performDisconnect = (reason?: string) => {
      shouldReconnectRef.current = false
      activeConnectionIdRef.current += 1
      connectionStatusRef.current = 'closing'
      clearReconnectTimer()
      clearHandshakeTimer()
      const socket = wsRef.current
      if (socket) {
        try {
          socket.close(1000, reason)
        } catch {}
        wsRef.current = null
      }
      expectedBinaryRef.current = null
      connectionStatusRef.current = 'idle'
      setIsConnectedSafe(false)
      setStatusSafe('disconnected')
      setPhaseSafe('idle')
      setConnectionErrorSafe(null)
      setErrorHintSafe(null)
      setClientId((prev) => (prev === null ? prev : null))
      setLeaderId((prev) => (prev === null ? prev : null))
    }

    if (!enabled) {
      performDisconnect('disabled')
      reconnectAttemptsRef.current = 0
      return () => {}
    }

    shouldReconnectRef.current = true
    reconnectAttemptsRef.current = 0
    connectionStatusRef.current = 'idle'
    setPhaseSafe('idle')
    connectRef.current?.()

    return () => {
      performDisconnect()
    }
  }, [enabled, sessionId, clearHandshakeTimer, clearReconnectTimer, setConnectionErrorSafe, setErrorHintSafe, setIsConnectedSafe, setPhaseSafe, setStatusSafe])

  const sendInput = useCallback((value: string | Uint8Array) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false
    }
    const payload = {
      type: 'input',
      dataBase64: base64From(value)
    }
    wsRef.current.send(JSON.stringify(payload))
    return true
  }, [])

  const sendResize = useCallback((cols: number, rows: number) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false
    }
    wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }))
    return true
  }, [])
  const sendScroll = useCallback((lines: number, atBottom?: boolean) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false
    }
    const delta = Number.isFinite(lines) ? Math.trunc(lines) : 0
    const clamped = Math.max(-500, Math.min(500, delta))
    const payload: { type: 'scroll'; lines: number; atBottom?: boolean } = {
      type: 'scroll',
      lines: clamped
    }
    if (atBottom) {
      payload.atBottom = true
    }
    wsRef.current.send(JSON.stringify(payload))
    return true
  }, [])

  const setLogging = useCallback((enabled: boolean) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false
    }
    wsRef.current.send(JSON.stringify({ type: 'set-logging', enabled }))
    return true
  }, [])

  const claimLeader = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !clientId) {
      return false
    }
    wsRef.current.send(JSON.stringify({ type: 'leader-claim', clientId }))
    return true
  }, [clientId])

  const acknowledge = useCallback((seq: number) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false
    }
    if (seq <= acknowledgedSeqRef.current) {
      return true
    }
    acknowledgedSeqRef.current = seq
    wsRef.current.send(JSON.stringify({ type: 'ack', upToSeq: seq }))
    return true
  }, [])

  const manualReconnect = useCallback(() => {
    shouldReconnectRef.current = true
    reconnectAttemptsRef.current = 0
    const nextConnect = connectRef.current
    if (nextConnect) {
      nextConnect()
    }
  }, [])

  const manualDisconnect = useCallback(() => {
    shouldReconnectRef.current = false
    clearReconnectTimer()
    connectionStatusRef.current = 'closing'
    clearSocket()
    connectionStatusRef.current = 'idle'
    setIsConnectedSafe(false)
    setStatusSafe('disconnected')
    setPhaseSafe('idle')
    clearHandshakeTimer()
  }, [clearHandshakeTimer, clearReconnectTimer, clearSocket, setIsConnectedSafe, setPhaseSafe, setStatusSafe])

  const connectionState = useMemo(() => ({
    isConnected,
    status,
    phase,
    connectionError,
    errorHint,
    clientId,
    leaderId
  }), [clientId, connectionError, errorHint, isConnected, leaderId, phase, status])

  return {
    ...connectionState,
    sendInput,
    sendResize,
    sendScroll,
    setLogging,
    claimLeader,
    acknowledge,
    reconnect: manualReconnect,
    disconnect: manualDisconnect
  }
}
