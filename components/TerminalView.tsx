'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useTerminal } from '@/hooks/useTerminal'
import { useWebSocket, type TerminalDataPacket } from '@/hooks/useWebSocket'
import { useTerminalRegistry } from '@/contexts/TerminalContext'
import type { Session } from '@/types/session'

const BRACKETED_PASTE_START = '\u001b[200~'
const BRACKETED_PASTE_END = '\u001b[201~'

const TERMINAL_DEBUG = process.env.NODE_ENV === 'development' || process.env.NEXT_PUBLIC_TERMINAL_DEBUG === 'true'

const debugLog = (...args: unknown[]) => {
  if (TERMINAL_DEBUG) {
    console.debug('[TerminalView]', ...args)
  }
}

const MAX_CONCURRENT_INITIALIZATIONS = 2
let activeInitializationCount = 0
const pendingInitializationResolvers: Array<() => void> = []

const acquireInitializationSlot = () => {
  return new Promise<void>((resolve) => {
    if (activeInitializationCount < MAX_CONCURRENT_INITIALIZATIONS) {
      activeInitializationCount += 1
      resolve()
      return
    }
    pendingInitializationResolvers.push(() => {
      activeInitializationCount += 1
      resolve()
    })
  })
}

const releaseInitializationSlot = () => {
  if (activeInitializationCount > 0) {
    activeInitializationCount -= 1
  }
  const next = pendingInitializationResolvers.shift()
  if (next) {
    next()
  }
}

interface TerminalViewProps {
  session: Session
  active?: boolean
}

export default function TerminalView({ session, active = true }: TerminalViewProps) {
  const terminalContainerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<HTMLDivElement>(null)
  const [isReady, setIsReady] = useState(false)
  const messageBufferRef = useRef<TerminalDataPacket[]>([])
  const flushScheduledRef = useRef(false)
  const flushHandleRef = useRef<number | null>(null)
  const latestSequenceRef = useRef(0)
  const acknowledgeRef = useRef<(seq: number) => void>(() => {})
  const pushResizeToServerRef = useRef<() => void>(() => {})
  const [notes, setNotes] = useState('')
  const [promptDraft, setPromptDraft] = useState('')
  const [isMobile, setIsMobile] = useState(false)
  const refreshTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [hasSelection, setHasSelection] = useState(false)
  const terminalCleanupRef = useRef<(() => void) | null>(null)
  const [isResetting, setIsResetting] = useState(false)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const initializingRef = useRef(false)
  const [selectionFirst] = useState(true)

  // CRITICAL: Initialize notesCollapsed from localStorage SYNCHRONOUSLY during render
  // This ensures the terminal container has the correct height BEFORE xterm.js initializes
  const [notesCollapsed, setNotesCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    const mobile = window.innerWidth < 768
    const collapsedKey = `session-notes-collapsed-${session.id}`
    const savedCollapsed = localStorage.getItem(collapsedKey)
    if (savedCollapsed !== null) {
      return savedCollapsed === 'true'
    }
    return mobile // Default to collapsed on mobile, expanded on desktop
  })

  const FOOTER_TAB_STORAGE_KEY = 'terminal-footer-tab'

  const [footerTab, setFooterTab] = useState<'notes' | 'prompt'>(() => {
    if (typeof window === 'undefined') return 'prompt'
    const stored = localStorage.getItem(FOOTER_TAB_STORAGE_KEY)
    return stored === 'notes' ? 'notes' : 'prompt'
  })

  const [loggingEnabled, setLoggingEnabled] = useState(() => {
    if (typeof window === 'undefined') return true
    const loggingKey = `session-logging-${session.id}`
    const savedLogging = localStorage.getItem(loggingKey)
    return savedLogging !== null ? savedLogging === 'true' : true
  })

  const [globalLoggingEnabled, setGlobalLoggingEnabled] = useState(false)
  const [policyMode, setPolicyMode] = useState<'normal' | 'replay-only'>('normal')
  const [policyReason, setPolicyReason] = useState<string | null>(null)
  const [isLeader, setIsLeader] = useState(false)

  const { registerTerminal, unregisterTerminal, reportActivity } = useTerminalRegistry()

  // Detect mobile on mount
  useEffect(() => {
    const isCoarsePointer = () => (typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)').matches : false)

    const checkMobile = () => {
      const coarse = isCoarsePointer()
      const mobile = coarse || window.innerWidth < 768
      setIsMobile(mobile)
    }
    checkMobile()
    window.addEventListener('resize', checkMobile)

    const mediaQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)') : null
    const handlePointerChange = () => checkMobile()
    mediaQuery?.addEventListener?.('change', handlePointerChange)

    return () => {
      window.removeEventListener('resize', checkMobile)
      mediaQuery?.removeEventListener?.('change', handlePointerChange)
    }
  }, [])

  // Fetch global logging configuration on mount
  useEffect(() => {
    fetch('/api/config')
      .then(res => res.json())
      .then(data => setGlobalLoggingEnabled(data.loggingEnabled))
      .catch(err => console.error('Failed to fetch config:', err))
  }, [])

  const rendererOverride = useMemo(() => {
    if (typeof window === 'undefined') {
      return null
    }
    const params = new URLSearchParams(window.location.search)
    const kind = params.get('renderer')
    return kind === 'canvas' ? 'canvas' : null
  }, [])

  const { terminal, initializeTerminal, fitTerminal, setWebglEnabled, setSelectionFirstMode } = useTerminal({
    sessionId: session.id,
    enableWebgl: active && !isMobile && rendererOverride !== 'canvas',
    onRegister: ({ fit }) => {
      registerTerminal(session.id, { fit })
    },
    onUnregister: () => {
      unregisterTerminal(session.id)
    },
  })

  // Store terminal in a ref so the WebSocket callback can access the current value
  const terminalInstanceRef = useRef<typeof terminal>(null)
  const resizeSentRef = useRef(false)
  const autoScrollRef = useRef(true)
  const scrollStateRef = useRef<{ viewportY: number; autoScroll: boolean } | null>(null)
  const scrollRestoredRef = useRef(false)
  const lastViewportRef = useRef(0)
  const pasteSinkRef = useRef<HTMLDivElement | null>(null)
  const pasteSinkActiveRef = useRef(false)
  const clipboardStatusTimerRef = useRef<NodeJS.Timeout | null>(null)
  const [clipboardStatus, setClipboardStatus] = useState<{ type: 'copy' | 'paste'; message: string } | null>(null)
  const pointerInsideRef = useRef(false)
  const sendScrollRef = useRef<(lines: number, atBottom?: boolean) => boolean>(() => false)
  const remoteScrollOffsetRef = useRef(0)
  const remoteScrollLimitRef = useRef(0)
  const [remoteScrollState, setRemoteScrollState] = useState<{ offset: number; limit: number }>({ offset: 0, limit: 0 })
  const [scrollMetricsSupported, setScrollMetricsSupported] = useState(false)
  const scrollMetricsSupportedRef = useRef(false)
  const scrollbarTrackRef = useRef<HTMLDivElement | null>(null)
  const scrollbarPointerActiveRef = useRef(false)
  const scrollbarPointerIdRef = useRef<number | null>(null)

  const scrollStorageKey = useMemo(() => `terminal-scroll-${session.id}`, [session.id])

  const persistScrollState = useCallback(() => {
    const term = terminalInstanceRef.current
    if (!term || typeof window === 'undefined') {
      return
    }
    const buffer = term.buffer.active
    const state = {
      viewportY: buffer.viewportY,
      autoScroll: autoScrollRef.current
    }
    scrollStateRef.current = state
    try {
      localStorage.setItem(scrollStorageKey, JSON.stringify(state))
    } catch (error) {
      debugLog(session.id, 'scroll:persist-error', error)
    }
  }, [scrollStorageKey, session.id])

  const focusTerminal = useCallback(() => {
    const term = terminalInstanceRef.current
    if (!term) return
    try {
      term.focus()
    } catch {}
  }, [])

  const updateLastViewport = useCallback(() => {
    const term = terminalInstanceRef.current
    if (!term) {
      return
    }
    const buffer = term.buffer.active
    lastViewportRef.current = buffer.viewportY
  }, [])

  const runWithViewportSync = useCallback((task: () => void) => {
    task()
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => {
        updateLastViewport()
      })
    } else {
      updateLastViewport()
    }
  }, [updateLastViewport])

  const applyRemoteScroll = useCallback((lines: number) => {
    if (!scrollMetricsSupportedRef.current) {
      return false
    }
    const handler = sendScrollRef.current
    if (typeof handler !== 'function') {
      return false
    }

    const prevOffset = remoteScrollOffsetRef.current
    const prevLimit = remoteScrollLimitRef.current

    if (lines === 0) {
      const accepted = handler(0, true)
      if (!accepted) {
        return false
      }
      remoteScrollOffsetRef.current = 0
      remoteScrollLimitRef.current = prevLimit
      autoScrollRef.current = true
      setShowScrollToBottom(false)
      setRemoteScrollState((prev) => {
        const limit = remoteScrollLimitRef.current
        if (prev.offset === 0 && prev.limit === limit) {
          return prev
        }
        return { offset: 0, limit }
      })
      return true
    }

    let nextOffset = prevOffset
    let nextLimit = prevLimit

    if (lines < 0) {
      nextOffset = prevOffset + Math.abs(lines)
      nextLimit = Math.max(prevLimit, nextOffset)
    } else {
      nextOffset = Math.max(0, prevOffset - lines)
    }

    const atBottom = lines > 0 && nextOffset === 0
    const accepted = handler(lines, atBottom)
    if (!accepted) {
      return false
    }

    remoteScrollOffsetRef.current = nextOffset
    remoteScrollLimitRef.current = nextLimit

    if (nextOffset === 0) {
      autoScrollRef.current = true
      setShowScrollToBottom(false)
    } else {
      autoScrollRef.current = false
      setShowScrollToBottom(true)
    }

    setRemoteScrollState((prev) => {
      if (prev.offset === nextOffset && prev.limit === nextLimit) {
        return prev
      }
      return { offset: nextOffset, limit: nextLimit }
    })

    return true
  }, [setRemoteScrollState, setShowScrollToBottom])

  useEffect(() => {
    void setWebglEnabled(active && !isMobile && rendererOverride !== 'canvas')
  }, [active, isMobile, rendererOverride, setWebglEnabled])

  useEffect(() => {
    remoteScrollOffsetRef.current = 0
    remoteScrollLimitRef.current = 0
    scrollMetricsSupportedRef.current = false
    setScrollMetricsSupported(false)
    setRemoteScrollState({ offset: 0, limit: 0 })
    setShowScrollToBottom(false)
  }, [session.id])

  const fallbackScrollLines = useCallback((lines: number) => {
    if (!Number.isFinite(lines) || lines === 0) {
      return false
    }
    const term = terminalInstanceRef.current
    if (!term) {
      return false
    }
    try {
      term.scrollLines(lines)
      return true
    } catch {
      return false
    }
  }, [])

  const fallbackScrollToBottom = useCallback(() => {
    const term = terminalInstanceRef.current
    if (!term) {
      return false
    }
    try {
      term.scrollToBottom()
      return true
    } catch {
      return false
    }
  }, [])

  const fallbackScrollToTop = useCallback(() => {
    const term = terminalInstanceRef.current
    if (!term) {
      return false
    }
    try {
      const buffer = term.buffer?.active
      const viewportY = buffer?.viewportY ?? 0
      if (viewportY !== 0) {
        term.scrollLines(-viewportY)
      }
      return true
    } catch {
      return false
    }
  }, [])

  const requestScroll = useCallback(
    (lines: number, options?: { snapToBottom?: boolean; snapToTop?: boolean }) => {
      const applied = applyRemoteScroll(lines)
      if (applied) {
        return
      }
      if (options?.snapToBottom) {
        if (fallbackScrollToBottom()) {
          return
        }
      }
      if (options?.snapToTop) {
        if (fallbackScrollToTop()) {
          return
        }
      }
      fallbackScrollLines(lines)
    },
    [applyRemoteScroll, fallbackScrollLines, fallbackScrollToBottom, fallbackScrollToTop]
  )

  // Apply selection-first policy (prevent app mouse-capture)
  useEffect(() => {
    if (!terminal) return
    try {
      setSelectionFirstMode(true)
    } catch (e) {
      console.warn('[TerminalView] setSelectionFirstMode failed:', e)
    }
  }, [terminal, setSelectionFirstMode])

  // Handle wheel events for scrolling; attach directly to terminal element and capture
  useEffect(() => {
    const el = terminalRef.current
    if (!el) return

    const handleWheel = (event: WheelEvent) => {
      const { deltaY, deltaMode } = event
      if (!deltaY) return

      event.preventDefault()
      event.stopPropagation()

      const divisor = deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 40 : 1
      const floatLines = deltaY / divisor
      if (!Number.isFinite(floatLines) || floatLines === 0) return

      let lines = Math.round(Math.abs(floatLines))
      if (lines === 0) lines = 1
      const signedLines = deltaY > 0 ? lines : -lines

      requestScroll(signedLines)
    }

    el.addEventListener('wheel', handleWheel, { passive: false, capture: true })
    return () => {
      el.removeEventListener('wheel', handleWheel, { capture: true } as any)
    }
  }, [requestScroll])

  const runInitialization = useCallback(async () => {
    const initStart = performance.now()
    const hostElement = terminalContainerRef.current
    const containerElement = terminalRef.current
    if (!hostElement || !containerElement) {
      debugLog(session.id, 'init:missing-container')
      console.error(`❌ [INIT-ERROR] Container missing for session ${session.id}`)
      return false
    }

    const rect = hostElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      debugLog(session.id, 'init:defer-zero-size', rect.width, rect.height)
      console.warn(`⏳ [INIT-DEFER] Terminal container has zero size for session ${session.id}, skipping init`)
      return false
    }

    if (initializingRef.current) {
      debugLog(session.id, 'init:already-running')
      return false
    }
    initializingRef.current = true
    let slotAcquired = false
    await acquireInitializationSlot()
    slotAcquired = true
    if (terminalCleanupRef.current) {
      try {
        terminalCleanupRef.current()
      } catch (error) {
        console.warn(`⚠️ [INIT-CLEANUP] Previous cleanup failed for session ${session.id}:`, error)
      }
      terminalCleanupRef.current = null
      debugLog(session.id, 'init:previous-cleanup')
    }

    debugLog(session.id, 'init:start')
    resizeSentRef.current = false
    setIsReady(false)

    try {
      const cleanup = await initializeTerminal(containerElement)
      terminalCleanupRef.current = cleanup ?? null
      setIsReady(true)
      debugLog(session.id, 'init:success')
      debugLog(session.id, 'init:duration', Math.round(performance.now() - initStart))
      autoScrollRef.current = true
      persistScrollState()
      updateLastViewport()
      return true
    } catch (error) {
      debugLog(session.id, 'init:error', error)
      console.error(`❌ [INIT-ERROR] Failed to initialize terminal for session ${session.id}:`, error)
      return false
    } finally {
      debugLog(session.id, 'init:complete')
      if (slotAcquired) {
        releaseInitializationSlot()
      }
      initializingRef.current = false
    }
  }, [initializeTerminal, session.id, persistScrollState, updateLastViewport])

  const handleReset = useCallback(async () => {
    if (isResetting) {
      return
    }

    setIsResetting(true)
    try {
      debugLog(session.id, 'reset:start')
      const success = await runInitialization()
      debugLog(session.id, 'reset:result', success)
      if (!success) {
        console.warn(`⚠️ [RESET] Terminal reset deferred for session ${session.id}`)
      }
    } finally {
      setIsResetting(false)
      debugLog(session.id, 'reset:complete')
    }
  }, [isResetting, runInitialization, session.id])

  // Track selection state to enable/disable Copy button accurately
  useEffect(() => {
    if (!terminal) {
      setHasSelection(false)
      return
    }

    const initialSelection = terminal.hasSelection?.() ?? false
    setHasSelection(initialSelection)
    debugLog(session.id, 'selection-init', initialSelection)

    const disposable = terminal.onSelectionChange(() => {
      try {
        const nextSelection = terminal.hasSelection?.() ?? false
        setHasSelection(nextSelection)
        debugLog(session.id, 'selection-change', nextSelection)
      } catch {
        setHasSelection(false)
        debugLog(session.id, 'selection-change:error')
      }
    })

    return () => {
      disposable.dispose()
      setHasSelection(false)
      debugLog(session.id, 'selection-cleanup')
    }
  }, [terminal, session.id])
  useEffect(() => {
    terminalInstanceRef.current = terminal
    if (terminal) {
      updateLastViewport()
    }
  }, [terminal, session.id, updateLastViewport])

  const preserveViewport = useCallback(
    (task: () => void, options?: { forceBottom?: boolean }) => {
      const term = terminalInstanceRef.current
      if (!term) {
        task()
        return
      }

      const buffer = term.buffer.active
      const prevViewport = buffer.viewportY
      const prevAutoScroll = autoScrollRef.current
      const wasAnchored = autoScrollRef.current

      runWithViewportSync(() => {
        task()

        const forceBottom = options?.forceBottom ?? false
        const currentBuffer = term.buffer.active

        if (forceBottom || wasAnchored) {
          autoScrollRef.current = true
          term.scrollToBottom()
        } else {
          const delta = prevViewport - currentBuffer.viewportY
          if (delta !== 0) {
            term.scrollLines(delta)
          }
          autoScrollRef.current = prevAutoScroll
        }
      })

      persistScrollState()
    },
    [persistScrollState, runWithViewportSync]
  )

  const jumpToBottom = useCallback(() => {
    const term = terminalInstanceRef.current
    if (!term) {
      return
    }
    requestScroll(0, { snapToBottom: true })
    preserveViewport(() => {
      term.scrollToBottom()
    }, { forceBottom: true })
    persistScrollState()
    focusTerminal()
    setShowScrollToBottom(false)
  }, [focusTerminal, persistScrollState, preserveViewport, requestScroll])

  const flushBuffer = useCallback(() => {
    const term = terminalInstanceRef.current
    if (!term) {
      return
    }
    if (messageBufferRef.current.length === 0) {
      return
    }

    const packets = messageBufferRef.current.splice(0, messageBufferRef.current.length)
    let latestSeq = 0

    preserveViewport(() => {
      packets.forEach((packet) => {
        term.write(packet.data)
        latestSeq = Math.max(latestSeq, packet.seq)
      })
    }, { forceBottom: autoScrollRef.current })

    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current)
    }
    refreshTimeoutRef.current = setTimeout(() => {
      if (terminalInstanceRef.current) {
        terminalInstanceRef.current.refresh(0, terminalInstanceRef.current.rows - 1)
      }
    }, 50)

    if (latestSeq > 0) {
      latestSequenceRef.current = Math.max(latestSequenceRef.current, latestSeq)
      acknowledgeRef.current(latestSeq)
    }
  }, [preserveViewport])

  const scheduleFlush = useCallback(() => {
    if (flushScheduledRef.current) {
      return
    }
    flushScheduledRef.current = true

    const execute = () => {
      flushScheduledRef.current = false
      flushHandleRef.current = null
      flushBuffer()
    }

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      flushHandleRef.current = window.requestAnimationFrame(execute)
    } else {
      execute()
    }
  }, [flushBuffer])

  const handleIncomingData = useCallback((packet: TerminalDataPacket) => {
    messageBufferRef.current.push(packet)
    scheduleFlush()

    if (packet.source !== 'live') {
      return
    }

    const payload = packet.data
    if (payload.length < 3) {
      return
    }

    const isPureEscape = payload.startsWith('\x1b') && !/[\x20-\x7E]/.test(payload)
    if (isPureEscape) {
      return
    }

    reportActivity(session.id)
  }, [reportActivity, scheduleFlush, session.id])

  const handleHistoryEvent = useCallback((event: 'begin' | 'end') => {
    if (event === 'begin') {
      remoteScrollOffsetRef.current = 0
      remoteScrollLimitRef.current = 0
      setRemoteScrollState({ offset: 0, limit: 0 })
      setShowScrollToBottom(false)
      return
    }
    if (event !== 'end') {
      return
    }

    const start = performance.now()
    if (!terminalInstanceRef.current) {
      return
    }

    const HOST_HISTORY_DELAY = 100
    setTimeout(() => {
      const forceBottom = autoScrollRef.current
      preserveViewport(() => {
        const term = terminalInstanceRef.current
        if (!term) {
          return
        }
        term.focus()
        term.clearSelection()
        term.refresh(0, term.rows - 1)
        fitTerminal()
      }, { forceBottom })

      const FINAL_REFRESH_DELAY = 50
      setTimeout(() => {
        preserveViewport(() => {
          const term = terminalInstanceRef.current
          if (!term) {
            return
          }
          const terminalElement = term.element
          if (terminalElement) {
            const clickEvent = new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window
            })
            terminalElement.dispatchEvent(clickEvent)
          }
          term.refresh(0, term.rows - 1)
        }, { forceBottom })

        pushResizeToServerRef.current()
        resizeSentRef.current = true
        debugLog(session.id, 'historyReplayComplete', Math.round(performance.now() - start))
      }, FINAL_REFRESH_DELAY)
    }, HOST_HISTORY_DELAY)
  }, [fitTerminal, preserveViewport, session.id])

  const remoteScrollThumb = useMemo(() => {
    if (!selectionFirst || !scrollMetricsSupported) {
      return { visible: false, topPercent: 100 }
    }
    const { offset, limit } = remoteScrollState
    if (limit <= 0) {
      return { visible: false, topPercent: 100 }
    }
    const clamped = Math.max(0, Math.min(limit, offset))
    const ratio = limit === 0 ? 0 : clamped / limit
    const topPercent = 100 - ratio * 100
    const bounded = Math.min(98, Math.max(2, topPercent))
    return { visible: true, topPercent: bounded }
  }, [remoteScrollState, selectionFirst, scrollMetricsSupported])

  const handleScrollStatus = useCallback(({ offset, limit }: { offset: number; limit: number }) => {
    const normalizedLimit = Math.max(0, limit)
    const normalizedOffset = Math.max(0, Math.min(normalizedLimit, offset))
    if (!scrollMetricsSupportedRef.current) {
      scrollMetricsSupportedRef.current = true
      setScrollMetricsSupported(true)
    }
    remoteScrollOffsetRef.current = normalizedOffset
    remoteScrollLimitRef.current = normalizedLimit
    setRemoteScrollState((prev) => {
      if (prev.offset === normalizedOffset && prev.limit === normalizedLimit) {
        return prev
      }
      return { offset: normalizedOffset, limit: normalizedLimit }
    })
    if (normalizedOffset === 0) {
      autoScrollRef.current = true
      setShowScrollToBottom(false)
    } else {
      autoScrollRef.current = false
      setShowScrollToBottom(true)
    }
  }, [])

  const scrollToRatio = useCallback((ratio: number) => {
    if (!scrollMetricsSupportedRef.current) {
      return
    }
    const limit = remoteScrollLimitRef.current
    if (limit <= 0) {
      return
    }
    const clampedRatio = Math.min(1, Math.max(0, ratio))
    const targetOffset = Math.round(limit * (1 - clampedRatio))
    const currentOffset = remoteScrollOffsetRef.current
    const delta = targetOffset - currentOffset
    if (delta === 0) {
      return
    }
    const lines = delta > 0 ? -delta : Math.abs(delta)
    applyRemoteScroll(lines)
  }, [applyRemoteScroll])

  const handleScrollbarPointerDrag = useCallback(
    (clientY: number) => {
      const track = scrollbarTrackRef.current
      if (!track) {
        return
      }
      const rect = track.getBoundingClientRect()
      if (rect.height <= 0) {
        return
      }
      const ratio = (clientY - rect.top) / rect.height
      scrollToRatio(ratio)
    },
    [scrollToRatio]
  )

  const handleScrollbarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!scrollMetricsSupportedRef.current) {
        return
      }
      if (!selectionFirst) {
        return
      }
      if (remoteScrollLimitRef.current <= 0) {
        return
      }
      scrollbarPointerActiveRef.current = true
      scrollbarPointerIdRef.current = event.pointerId
      event.preventDefault()
      const track = scrollbarTrackRef.current
      try {
        track?.setPointerCapture(event.pointerId)
      } catch {}
      handleScrollbarPointerDrag(event.clientY)
    },
    [handleScrollbarPointerDrag, selectionFirst]
  )

  const handleScrollbarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!scrollbarPointerActiveRef.current) {
        return
      }
      event.preventDefault()
      handleScrollbarPointerDrag(event.clientY)
    },
    [handleScrollbarPointerDrag]
  )

  const markPointerInside = useCallback((inside: boolean) => {
    pointerInsideRef.current = inside
  }, [])

  const handleScrollbarPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrollbarPointerActiveRef.current) {
      return
    }
    scrollbarPointerActiveRef.current = false
    scrollbarPointerIdRef.current = null
    event.preventDefault()
    const track = scrollbarTrackRef.current
    try {
      track?.releasePointerCapture(event.pointerId)
    } catch {}
  }, [])

  useEffect(() => {
    if (scrollbarPointerActiveRef.current) {
      const pointerId = scrollbarPointerIdRef.current
      scrollbarPointerActiveRef.current = false
      scrollbarPointerIdRef.current = null
      const track = scrollbarTrackRef.current
      if (track && pointerId !== null) {
        try {
          track.releasePointerCapture(pointerId)
        } catch {}
      }
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const preventOuterScroll = (event: WheelEvent) => {
      if (!pointerInsideRef.current) {
        return
      }
      if (event.defaultPrevented) {
        return
      }
      event.preventDefault()
    }
    window.addEventListener('wheel', preventOuterScroll, { passive: false })
    return () => {
      window.removeEventListener('wheel', preventOuterScroll)
      pointerInsideRef.current = false
    }
  }, [])

  const handlePolicyUpdate = useCallback((mode: 'normal' | 'replay-only', reason?: string) => {
    setPolicyMode(mode)
    setPolicyReason(mode === 'replay-only' ? (reason ?? null) : null)
  }, [])

  const handleGatewayError = useCallback((event: Event) => {
    console.error('WebSocket error:', event)
  }, [])

  const {
    phase,
    isConnected,
    connectionError,
    errorHint,
    clientId: gatewayClientId,
    leaderId: gatewayLeaderId,
    sendInput,
    sendScroll,
    sendResize,
    setLogging: setGatewayLogging,
    claimLeader,
    acknowledge,
    reconnect: reconnectGateway
  } = useWebSocket({
    sessionId: session.id,
    enabled: active,
    onOpen: () => {
      reportActivity(session.id)
    },
    onData: handleIncomingData,
    onHistoryEvent: handleHistoryEvent,
    onLeaderChange: () => {},
    onPolicy: handlePolicyUpdate,
    onError: handleGatewayError,
    onClose: () => {},
    onScrollStatus: handleScrollStatus
  })

  useEffect(() => {
    sendScrollRef.current = (lines: number, atBottom?: boolean) => sendScroll(lines, atBottom)
  }, [sendScroll])


  const handlePasteBubble = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    if (target?.classList?.contains('xterm-helper-textarea')) {
      return
    }

    if (pasteSinkRef.current && target === pasteSinkRef.current) {
      // Let the browser populate the sink, then forward contents to terminal
      setTimeout(() => {
        const sink = pasteSinkRef.current
        if (!sink) {
          pasteSinkActiveRef.current = false
          return
        }
        const sinkText = sink.textContent ?? ''
        sink.textContent = ''
        pasteSinkActiveRef.current = false
        if (!sinkText) {
          focusTerminal()
          return
        }
        const normalizedSink = sinkText.replace(/\r\n?/g, '\n').replace(/\u001b/g, '')
        if (!normalizedSink) {
          focusTerminal()
          return
        }
        const payload = `${BRACKETED_PASTE_START}${normalizedSink.replace(/\n/g, '\r')}${BRACKETED_PASTE_END}`
        const accepted = sendInput(payload)
        if (accepted) {
          focusTerminal()
          announceClipboardStatus('paste', `Pasted ${normalizedSink.length} chars`)
        } else {
          announceClipboardStatus('paste', 'Paste failed: terminal not ready')
        }
      }, 0)
      return
    }

    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (!text) {
      return
    }

    const normalized = text.replace(/\r\n?/g, '\n').replace(/\u001b/g, '')
    if (!normalized) {
      return
    }

    event.preventDefault()
    const payload = `${BRACKETED_PASTE_START}${normalized.replace(/\n/g, '\r')}${BRACKETED_PASTE_END}`
    const accepted = sendInput(payload)
    if (accepted) {
      focusTerminal()
      announceClipboardStatus('paste', `Pasted ${normalized.length} chars`)
    } else {
      announceClipboardStatus('paste', 'Paste failed: terminal not ready')
    }
  }, [sendInput, focusTerminal])

  const handleCopyBubble = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    if (target?.classList?.contains('xterm-helper-textarea')) {
      return
    }

    if (!terminal?.hasSelection?.()) {
      return
    }

    const selection = terminal.getSelection?.() ?? ''
    if (!selection) {
      return
    }

    event.clipboardData?.setData('text/plain', selection)
    event.preventDefault()
    announceClipboardStatus('copy', 'Copied selection')
  }, [terminal])

  useEffect(() => {
    if (!active) {
      return
    }

    const handler = (event: KeyboardEvent) => {
      const activeElement = document.activeElement as HTMLElement | null
      const helperFocused = activeElement?.classList?.contains('xterm-helper-textarea')
      const containerFocused = terminalRef.current?.contains(activeElement ?? null)

      const rawKey = event.key
      const key = rawKey.toLowerCase()
      // Legacy App Mouse toggle removed

      if (containerFocused && !helperFocused) {
        const noOtherModifiers = !event.ctrlKey && !event.metaKey && !event.altKey
        if (noOtherModifiers) {
          const term = terminalInstanceRef.current
          const rows = term?.rows ?? 24
          const pageLines = Math.max(rows - 2, 10)
          let scrollLines = 0
          let handled = false
          let snapToBottom = false
          let snapToTop = false

          switch (rawKey) {
            case 'PageUp':
              scrollLines = -pageLines
              handled = true
              break
            case 'PageDown':
              scrollLines = pageLines
              handled = true
              break
            case 'ArrowUp':
              if (event.shiftKey) {
                scrollLines = -5
                handled = true
              }
              break
            case 'ArrowDown':
              if (event.shiftKey) {
                scrollLines = 5
                handled = true
              }
              break
            case 'Home':
              scrollLines = -(remoteScrollLimitRef.current > 0 ? remoteScrollLimitRef.current : rows * 25)
              snapToTop = true
              handled = true
              break
            case 'End': {
              const offset = remoteScrollOffsetRef.current
              if (offset > 0) {
                scrollLines = offset
              } else {
                scrollLines = rows * 25
              }
              snapToBottom = true
              handled = true
              break
            }
            default:
              break
          }

          if (handled) {
            event.preventDefault()
            event.stopPropagation()
            requestScroll(scrollLines, { snapToBottom, snapToTop })
            return
          }
        }
      }

      const isCopy = key === 'c' && (event.ctrlKey || event.metaKey)
      const isPaste = key === 'v' && (event.ctrlKey || event.metaKey)
      if (!isCopy && !isPaste) {
        return
      }

      if (!helperFocused && containerFocused) {
        if (isPaste) {
          pasteSinkActiveRef.current = true
          const sink = pasteSinkRef.current
          if (sink) {
            sink.textContent = ''
            sink.focus({ preventScroll: true })
            const range = document.createRange()
            range.selectNodeContents(sink)
            range.collapse(true)
            const selection = window.getSelection()
            selection?.removeAllRanges()
            selection?.addRange(range)
          }
        } else if (isCopy) {
          // If terminal has a selection, perform a copy and prevent ^C from being sent
          if (terminal?.hasSelection?.()) {
            event.preventDefault()
            let ok = false
            try {
              ok = document.execCommand('copy')
            } catch {}
            if (!ok) {
              try {
                const sel = terminal.getSelection?.() ?? ''
                if (sel && navigator.clipboard?.writeText) {
                  void navigator.clipboard
                    .writeText(sel)
                    .then(
                      () => announceClipboardStatus('copy', 'Copied selection'),
                      () => announceClipboardStatus('copy', 'Clipboard blocked by browser')
                    )
                }
              } catch {}
            }
            if (ok) {
              announceClipboardStatus('copy', 'Copied selection')
            } else if (!navigator.clipboard?.writeText) {
              announceClipboardStatus('copy', 'Copied selection')
            }
            return
          }
          // No selection: focus terminal so ^C reaches PTY as interrupt
          focusTerminal()
        }
      }
      return
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [active, terminal, sendInput, focusTerminal, requestScroll, session.id])

  useEffect(() => {
    debugLog(session.id, 'phase', phase)
  }, [phase, session.id])

  useEffect(() => {
    if (policyMode === 'replay-only' || policyReason) {
      debugLog(session.id, 'policy', policyMode, policyReason)
    }
  }, [policyMode, policyReason, session.id])

  const handleManualReconnect = useCallback(() => {
    reconnectGateway()
  }, [reconnectGateway])

  const showConnectionOverlay = useMemo(() => {
    if (!isReady) {
      return true
    }
    return phase !== 'ready'
  }, [isReady, phase])

  const connectionOverlayMessage = useMemo(() => {
    if (!isReady) {
      return 'Initializing terminal...'
    }

    switch (phase) {
      case 'connecting':
        return 'Connecting to terminal gateway...'
      case 'handshake':
        return 'Negotiating session handshake...'
      case 'history':
        return policyReason ?? 'Replaying recent terminal history...'
      case 'error':
        return connectionError?.message ?? 'Unable to connect to terminal gateway'
      default:
        return null
    }
  }, [connectionError, isReady, phase, policyReason])

  const overlayIsError = phase === 'error'
  const policyStatusMessage = useMemo(() => {
    if (policyMode !== 'replay-only') {
      return null
    }
    return policyReason
  }, [policyMode, policyReason])

  useEffect(() => {
    setIsLeader(Boolean(gatewayClientId) && gatewayClientId === gatewayLeaderId)
  }, [gatewayClientId, gatewayLeaderId])

  useEffect(() => {
    if (!isConnected) {
      setPolicyMode('normal')
      setPolicyReason(null)
      setIsLeader(false)
      setShowScrollToBottom(false)
      remoteScrollOffsetRef.current = 0
      remoteScrollLimitRef.current = 0
      scrollMetricsSupportedRef.current = false
      setScrollMetricsSupported(false)
      setRemoteScrollState({ offset: 0, limit: 0 })
    }
  }, [isConnected])

  const pushResizeToServer = useCallback(() => {
    const term = terminalInstanceRef.current
    if (!term) return
    if (!isConnected || !isLeader) return
    sendResize(term.cols, term.rows)
  }, [isConnected, isLeader, sendResize])

  useEffect(() => {
    acknowledgeRef.current = acknowledge
  }, [acknowledge])

  useEffect(() => {
    pushResizeToServerRef.current = pushResizeToServer
  }, [pushResizeToServer])

  useEffect(() => {
    if (!terminal) return

    updateLastViewport()

    const disposable = terminal.onScroll((newViewportY) => {
      const buffer = terminal.buffer.active
      const nextViewport = typeof newViewportY === 'number' ? newViewportY : buffer.viewportY
      lastViewportRef.current = nextViewport

      const prevAuto = autoScrollRef.current
      const atBottom = nextViewport >= buffer.baseY

      if (prevAuto !== atBottom) {
        debugLog(session.id, 'scroll:anchor-change', atBottom)
      }

      autoScrollRef.current = atBottom
      setShowScrollToBottom((prev) => (atBottom ? false : true))
      persistScrollState()
    })

    return () => {
      disposable.dispose()
    }
  }, [terminal, session.id, persistScrollState, updateLastViewport])

  useEffect(() => {
    if (!terminal || !isReady || scrollRestoredRef.current) {
      return
    }
    if (typeof window === 'undefined') {
      return
    }

    const raw = localStorage.getItem(scrollStorageKey)
    if (!raw) {
      scrollRestoredRef.current = true
      return
    }

    try {
      const saved = JSON.parse(raw) as { viewportY?: number; autoScroll?: boolean }
      if (!saved || typeof saved.viewportY !== 'number') {
        scrollRestoredRef.current = true
        return
      }

      scrollStateRef.current = {
        viewportY: saved.viewportY,
        autoScroll: saved.autoScroll !== false
      }

      if (saved.autoScroll === false) {
        autoScrollRef.current = false
        preserveViewport(() => {
          const term = terminalInstanceRef.current
          if (!term) {
            return
          }
          const buffer = term.buffer.active
          const delta = saved.viewportY! - buffer.viewportY
          if (delta !== 0) {
            term.scrollLines(delta)
          }
        }, { forceBottom: false })
        setShowScrollToBottom(true)

      } else {
        autoScrollRef.current = true
        preserveViewport(() => {
          const term = terminalInstanceRef.current
          if (!term) {
            return
          }
        }, { forceBottom: true })
        setShowScrollToBottom(false)
      }

      persistScrollState()
      scrollRestoredRef.current = true
    } catch (error) {
      console.warn('Failed to restore scroll state:', error)
      scrollRestoredRef.current = true
    }
  }, [terminal, isReady, scrollStorageKey, preserveViewport, persistScrollState])

  useEffect(() => {
    if (!isConnected) {
      resizeSentRef.current = false
      persistScrollState()
    }
  }, [isConnected, persistScrollState])

  useEffect(() => {
    return () => {
      autoScrollRef.current = true
      persistScrollState()
    }
  }, [persistScrollState])

  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        persistScrollState()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [persistScrollState])

  // Initialize terminal ONCE on mount - never re-initialize
  // Tab-based architecture: terminal stays mounted, just hidden via CSS
  useEffect(() => {
    let disposed = false
    let retryTimeout: NodeJS.Timeout | null = null

    const attemptInit = async () => {
      if (disposed) return
      const success = await runInitialization()
      debugLog(session.id, 'init:attempt', success)
      if (!success && !disposed) {
        debugLog(session.id, 'init:retry')
        retryTimeout = setTimeout(attemptInit, 120)
      }
    }

    attemptInit()

    return () => {
      disposed = true
      if (retryTimeout) {
        clearTimeout(retryTimeout)
      }
      if (terminalCleanupRef.current) {
        try {
          terminalCleanupRef.current()
        } catch (error) {
          console.warn(`⚠️ [INIT-CLEANUP] Cleanup failed for session ${session.id}:`, error)
        }
        terminalCleanupRef.current = null
        debugLog(session.id, 'init:cleanup-dispose')
      }
      setIsReady(false)
      messageBufferRef.current = []
      debugLog(session.id, 'init:unmount')
    }
  }, [runInitialization, session.id])

  // Flush buffered messages when terminal becomes ready
  useEffect(() => {
    if (terminal && messageBufferRef.current.length > 0) {
      scheduleFlush()
    }
  }, [terminal, scheduleFlush])

  // Mobile-specific: trigger fit when notes collapse/expand (changes terminal height on mobile)
  useEffect(() => {
    if (!terminal || !isReady) {
      return
    }
    const delay = isMobile ? 150 : 60
    const timeout = setTimeout(() => {
      preserveViewport(() => {
        fitTerminal()
      }, { forceBottom: autoScrollRef.current })
      pushResizeToServer()
    }, delay)
    return () => clearTimeout(timeout)
  }, [notesCollapsed, footerTab, isMobile, isReady, terminal, fitTerminal, session.id, active, pushResizeToServer, preserveViewport])

  useEffect(() => {
    if (!terminal || !isConnected || !isReady) {
      return
    }
    if (resizeSentRef.current) {
      return
    }
    pushResizeToServer()
    resizeSentRef.current = true
  }, [terminal, isConnected, isReady, pushResizeToServer])

  // When this terminal view becomes active/visible again, re-initialize selection overlay
  // and force a full repaint to avoid stale layers after being hidden.
  useEffect(() => {
    if (!active) return
    if (!terminal) {
      runInitialization()
      return
    }
    const container = terminalContainerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    preserveViewport(() => {
      terminal.focus()
      terminal.clearSelection()
      terminal.refresh(0, terminal.rows - 1)
      fitTerminal()
    }, { forceBottom: autoScrollRef.current })
    if (autoScrollRef.current) {
      setShowScrollToBottom(false)
    }
    pushResizeToServer()
  }, [active, terminal, runInitialization, fitTerminal, pushResizeToServer, preserveViewport])

  // Handle terminal input
  useEffect(() => {
    if (!terminal || !isConnected) {
      return
    }

    const disposable = terminal.onData((data) => {
      sendInput(data)
    })

    return () => {
      disposable.dispose()
    }
  }, [terminal, isConnected, sendInput])

  useEffect(() => {
    if (!terminal) {
      return
    }

    const pasteDisposable = (terminal as unknown as { onPaste?: (listener: (data: string) => void) => { dispose: () => void } }).onPaste?.((raw) => {
      if (!raw) {
        return
      }

      const normalized = raw.replace(/\r\n?/g, '\n')
      const sanitized = normalized.replace(/\u001b/g, '')

      if (sanitized.length === 0) {
        return
      }

      const prepared = sanitized.replace(/\n/g, '\r')
      const payload = `${BRACKETED_PASTE_START}${prepared}${BRACKETED_PASTE_END}`
      const accepted = sendInput(payload)
      if (accepted) {
        focusTerminal()
      }
    })

    return () => {
      pasteDisposable?.dispose?.()
    }
  }, [terminal, sendInput, focusTerminal])

  // Handle terminal resize
  useEffect(() => {
    if (!terminal || !isConnected) return

    const disposable = terminal.onResize(({ cols, rows }) => {
      if (!isLeader) {
        return
      }
      sendResize(cols, rows)
    })

    return () => {
      disposable.dispose()
    }
  }, [terminal, isConnected, isLeader, sendResize])

  // Mobile touch scroll handler - support direct drags and stealing scroll when page hits edges
  useEffect(() => {
    if (!isMobile || !terminal) return
    const terminalElement = terminalRef.current
    if (!terminalElement) return

    let touchStartY = 0
    let lastTouchY: number | null = null
    let activeGesture: 'none' | 'single' | 'multi' = 'none'
    let multiLastMidY = 0
    let multiLastDistance: number | null = null

    const PINCH_THRESHOLD = 28 // px change between pointers signals pinch zoom
    const PX_PER_LINE_SINGLE = 20
    const PX_PER_LINE_MULTI = 18

    const setTouchAction = (value: string) => {
      terminalElement.style.touchAction = value
    }

    const restoreTouchAction = () => {
      setTouchAction('pan-y pinch-zoom')
    }

    const beginManualScroll = () => {
      if (autoScrollRef.current) {
        autoScrollRef.current = false
      }
      setTouchAction('none')
    }

    const anyTouchInside = (touches: TouchList, rect: DOMRect) => {
      for (let i = 0; i < touches.length; i += 1) {
        const touch = touches[i]
        if (
          touch.clientX >= rect.left &&
          touch.clientX <= rect.right &&
          touch.clientY >= rect.top &&
          touch.clientY <= rect.bottom
        ) {
          return true
        }
      }
      return false
    }

    restoreTouchAction()

    const handleTouchStart = (e: TouchEvent) => {
      const { touches } = e
      if (touches.length === 0) return

      const rect = terminalElement.getBoundingClientRect()
      const inside = anyTouchInside(touches, rect)
      markPointerInside(inside)

      multiLastDistance = null
      lastTouchY = null

      if (touches.length >= 2 && inside) {
        const touchA = touches[0]
        const touchB = touches[1]
        multiLastMidY = (touchA.clientY + touchB.clientY) / 2
        multiLastDistance = Math.hypot(touchA.clientX - touchB.clientX, touchA.clientY - touchB.clientY)
        activeGesture = 'multi'
        beginManualScroll()
        return
      }

      if (touches.length === 1 && inside) {
        const touch = touches[0]
        touchStartY = touch.clientY
        lastTouchY = touch.clientY
        activeGesture = 'single'
        beginManualScroll()
        return
      }

      activeGesture = 'none'
      restoreTouchAction()
    }

    const handleTouchMove = (e: TouchEvent) => {
      const { touches } = e
      if (touches.length === 0) return

      if (activeGesture === 'multi') {
        if (touches.length < 2) {
          activeGesture = 'none'
          restoreTouchAction()
          return
        }

        const touchA = touches[0]
        const touchB = touches[1]
        const midY = (touchA.clientY + touchB.clientY) / 2
        const distance = Math.hypot(touchA.clientX - touchB.clientX, touchA.clientY - touchB.clientY)

        if (multiLastDistance && Math.abs(distance - multiLastDistance) > PINCH_THRESHOLD) {
          activeGesture = 'none'
          restoreTouchAction()
          return
        }

        const deltaY = multiLastMidY - midY
        const linesToScroll = Math.round(deltaY / PX_PER_LINE_MULTI)
        if (linesToScroll !== 0) {
          terminal.scrollLines(linesToScroll)
          multiLastMidY = midY
          multiLastDistance = distance
          persistScrollState()
        }

        lastTouchY = null
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (activeGesture === 'single') {
        const touch = touches[0]
        const previousY = lastTouchY ?? touchStartY
        const deltaY = previousY - touch.clientY
        const linesToScroll = Math.round(deltaY / PX_PER_LINE_SINGLE)

        if (linesToScroll !== 0) {
          terminal.scrollLines(linesToScroll)
          persistScrollState()
        }

        touchStartY = touch.clientY
        lastTouchY = touch.clientY

        e.preventDefault()
        e.stopPropagation()
        return
      }

      const rect = terminalElement.getBoundingClientRect()
      const inside = anyTouchInside(touches, rect)

      const docEl = document.documentElement
      const atPageTop = window.scrollY <= 0
      const atPageBottom =
        window.innerHeight + window.scrollY >= (docEl?.scrollHeight ?? document.body.scrollHeight) - 1

      // Fallback: steal scroll if the page hits an edge while dragging upward/downward inside terminal
      if (inside && touches.length === 1) {
        const touch = touches[0]
        const previousY = lastTouchY ?? touch.clientY
        const deltaY = previousY - touch.clientY
        const scrollingDown = deltaY > 0
        const scrollingUp = deltaY < 0

        if ((atPageBottom && scrollingDown) || (atPageTop && scrollingUp)) {
          activeGesture = 'single'
          touchStartY = touch.clientY
          lastTouchY = touch.clientY
          beginManualScroll()
          e.preventDefault()
          e.stopPropagation()
        }
      }
    }

    const endGesture = () => {
      activeGesture = 'none'
      multiLastDistance = null
      lastTouchY = null
      restoreTouchAction()
      markPointerInside(false)
    }

    document.addEventListener('touchstart', handleTouchStart, { passive: true, capture: true })
    document.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true })
    document.addEventListener('touchend', endGesture, { passive: true, capture: true })
    document.addEventListener('touchcancel', endGesture, { passive: true, capture: true })

    return () => {
      document.removeEventListener('touchstart', handleTouchStart, true)
      document.removeEventListener('touchmove', handleTouchMove, true)
      document.removeEventListener('touchend', endGesture, true)
      document.removeEventListener('touchcancel', endGesture, true)
      restoreTouchAction()
    }
  }, [isMobile, terminal, persistScrollState, markPointerInside])

  // Load notes from localStorage ONCE on mount
  // Tab-based architecture: notes stay in memory, no need to reload on session switch
  useEffect(() => {
    const storageKey = `session-notes-${session.id}`
    const savedNotes = localStorage.getItem(storageKey)
    if (savedNotes !== null) {
      setNotes(savedNotes)
    } else {
      setNotes('')
    }
    // Only load once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const storageKey = `session-prompt-${session.id}`
    const savedPrompt = localStorage.getItem(storageKey)
    if (savedPrompt !== null) {
      setPromptDraft(savedPrompt)
    } else {
      setPromptDraft('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Save notes to localStorage when they change
  useEffect(() => {
    const storageKey = `session-notes-${session.id}`
    localStorage.setItem(storageKey, notes)
  }, [notes, session.id])

  useEffect(() => {
    const storageKey = `session-prompt-${session.id}`
    localStorage.setItem(storageKey, promptDraft)
  }, [promptDraft, session.id])

  useEffect(() => {
    if (notesCollapsed) return
    if (footerTab !== 'prompt') return
    const textarea = promptTextareaRef.current
    if (!textarea) return
    const timer = requestAnimationFrame(() => {
      try {
        textarea.focus()
        const end = textarea.value.length
        textarea.setSelectionRange(end, end)
      } catch {}
    })
    return () => cancelAnimationFrame(timer)
  }, [footerTab, notesCollapsed])

  // Save collapsed state to localStorage
  useEffect(() => {
    const collapsedKey = `session-notes-collapsed-${session.id}`
    localStorage.setItem(collapsedKey, String(notesCollapsed))
  }, [notesCollapsed, session.id])

  // Save logging state to localStorage
  useEffect(() => {
    const loggingKey = `session-logging-${session.id}`
    localStorage.setItem(loggingKey, String(loggingEnabled))
  }, [loggingEnabled, session.id])

  useEffect(() => {
    localStorage.setItem(FOOTER_TAB_STORAGE_KEY, footerTab)
  }, [footerTab])

  // Send logging state to server when it changes
  useEffect(() => {
    if (!isConnected) return
    setGatewayLogging(loggingEnabled)
  }, [loggingEnabled, isConnected, setGatewayLogging])

  // Toggle logging handler
  const toggleLogging = () => {
    setLoggingEnabled(!loggingEnabled)
  }

  const handlePromptSubmit = useCallback(
    (mode: 'insert' | 'send') => {
      if (!promptDraft || promptDraft.trim().length === 0) {
        return
      }

      autoScrollRef.current = true

      const normalized = promptDraft.replace(/\r\n?/g, '\n')
      const withoutEscape = normalized.replace(/\u001b/g, '')
      const carriageAdjusted = withoutEscape.replace(/\n/g, '\r')
      const bracketedPayload = `${BRACKETED_PASTE_START}${carriageAdjusted}${BRACKETED_PASTE_END}`

      const staged = sendInput(bracketedPayload)
      if (!staged) {
        console.warn('[PromptBuilder] Failed to send staged text via WebSocket')
        return
      }

      if (mode === 'send') {
        const executed = sendInput('\r')
        if (!executed) {
          console.warn('[PromptBuilder] Failed to send Enter via WebSocket')
          return
        }
        setPromptDraft('')
        focusTerminal()
        persistScrollState()
      }
    },
    [focusTerminal, persistScrollState, promptDraft, sendInput]
  )

  const handlePromptKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        handlePromptSubmit('insert')
        return
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        handlePromptSubmit('send')
      }
    },
    [handlePromptSubmit]
  )

  return (
    <div className="flex-1 flex flex-col bg-terminal-bg">
      {/* Terminal Header */}
      <div className="px-3 md:px-4 py-2 border-b border-gray-700 bg-gray-800">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 md:gap-3 min-w-0">
            <h3 className="font-medium text-gray-100 text-sm md:text-base truncate">
              {session.name || session.id}
            </h3>
            <ConnectionIndicator
              isConnected={isConnected}
              isLeader={isLeader}
              policyMode={policyMode}
              policyReason={policyReason}
            />
          </div>
          {terminal && (
            <div className="flex items-center gap-2 md:gap-3 text-xs text-gray-400 flex-shrink-0">
              {/* Legacy App Mouse/Select First control removed */}
              {/* Mobile: Notes toggle button */}
              <button
                onClick={() => setNotesCollapsed(!notesCollapsed)}
                className="md:hidden px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors text-xs"
                title={notesCollapsed ? "Show footer" : "Hide footer"}
              >
                📝
              </button>
              <span className="text-gray-500 md:hidden">|</span>

              {/* Hide on mobile except Clear and Notes buttons */}
              <span className="hidden md:inline">
                {terminal.cols}x{terminal.rows}
              </span>
              <span className="text-gray-500 hidden md:inline">|</span>
              <span className="hidden md:inline" title={`Buffer: ${terminal.buffer.active.length} lines (max: 50000)`}>
                📜 {terminal.buffer.active.length} lines
              </span>
              <span className="text-gray-500 hidden md:inline">|</span>
              <span className="hidden md:inline" title="Shift+PageUp/PageDown: Scroll by page&#10;Shift+Arrow Up/Down: Scroll 5 lines&#10;Shift+Home/End: Jump to top/bottom&#10;Or use mouse wheel/trackpad">
                ⌨️ Shift+PgUp/PgDn • Shift+↑/↓
              </span>
              <span className="text-gray-500 hidden md:inline">|</span>
              <button
                onClick={() => claimLeader()}
                disabled={!isConnected || isLeader}
                className={`px-2 py-1 rounded transition-colors text-xs ${
                  isLeader
                    ? 'bg-blue-700 text-white cursor-default'
                    : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                }`}
                title={isLeader ? 'You are the resize leader' : 'Claim resize leadership'}
              >
                {isLeader ? 'Leader' : 'Claim Leader'}
              </button>
              <span className="text-gray-500 hidden md:inline">|</span>
              {policyMode === 'replay-only' && (
                <>
                  <span className="text-amber-400 hidden md:inline" title="Gateway applied slow-client policy to preserve performance">
                    Replay-only mode
                  </span>
                  <span className="text-gray-500 hidden md:inline">|</span>
                </>
              )}
              <button
                onClick={globalLoggingEnabled ? toggleLogging : undefined}
                disabled={!globalLoggingEnabled}
                className={`px-2 py-1 rounded transition-colors text-xs ${
                  !globalLoggingEnabled
                    ? 'bg-gray-800 text-gray-500 cursor-not-allowed opacity-50'
                    : loggingEnabled
                    ? 'bg-green-700 hover:bg-green-600 text-white'
                    : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                }`}
                title={
                  !globalLoggingEnabled
                    ? 'Session logging disabled globally (set ENABLE_LOGGING=true in .env.local to enable)'
                    : loggingEnabled
                    ? 'Logging enabled - Click to disable'
                    : 'Logging disabled - Click to enable'
                }
              >
                {loggingEnabled ? '📝' : '🚫'} <span className="hidden md:inline">{loggingEnabled ? 'Logging' : 'No Log'}</span>
              </button>
              <span className="text-gray-500 hidden md:inline">|</span>
              <button
                onClick={() => terminal.clear()}
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors text-xs"
                title="Clear terminal scrollback buffer (removes duplicate lines from Claude Code status updates)"
              >
                🧹 <span className="hidden md:inline">Clear</span>
              </button>
              <button
                onClick={handleReset}
                className={`px-2 py-1 rounded transition-colors text-xs ${
                  isResetting
                    ? 'bg-gray-800 text-gray-500 cursor-wait opacity-70'
                    : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                }`}
                title="Dispose and reinitialize the terminal display"
                disabled={isResetting}
              >
                {isResetting ? '⏳' : '🔄'} <span className="hidden md:inline">Reset</span>
              </button>
              <button
                onClick={async () => {
                  try {
                    const selection = terminal.getSelection()
                    if (!selection) {
                      return
                    }

                    if (navigator.clipboard && navigator.clipboard.writeText) {
                      await navigator.clipboard.writeText(selection)
                      announceClipboardStatus('copy', 'Copied selection')
                      return
                    }

                    const textarea = document.createElement('textarea')
                    textarea.value = selection
                    textarea.style.position = 'fixed'
                    textarea.style.left = '-9999px'
                    document.body.appendChild(textarea)
                    textarea.select()
                    try {
                      document.execCommand('copy')
                      announceClipboardStatus('copy', 'Copied selection')
                    } finally {
                      document.body.removeChild(textarea)
                    }
                  } catch (e) {
                    console.warn('Copy failed:', e)
                    announceClipboardStatus('copy', 'Clipboard blocked by browser')
                  }
                }}
                className={`px-2 py-1 rounded transition-colors text-xs ${
                  hasSelection
                    ? 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                    : 'bg-gray-800 text-gray-500 cursor-not-allowed opacity-60'
                }`}
                title={hasSelection ? 'Copy selected text to clipboard' : 'Select text to enable copy'}
                disabled={!hasSelection}
              >
                📋 <span className="hidden md:inline">Copy</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Connection Error */}
      {connectionError && (
        <div className="px-4 py-3 bg-red-900/20 border-b border-red-800">
          <p className="text-sm text-red-400 mb-2">
            ⚠️ {connectionError.message}
          </p>
          {errorHint && (
            <div className="mt-2 p-2 bg-gray-800/50 rounded border border-gray-700">
              <p className="text-xs text-gray-300 font-mono">
                💡 {errorHint}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Terminal Container */}
      <div
        ref={terminalContainerRef}
        className="flex-1 relative min-h-0"
        onPointerEnter={() => markPointerInside(true)}
        onPointerLeave={() => markPointerInside(false)}
        onMouseEnter={() => markPointerInside(true)}
        onMouseLeave={() => markPointerInside(false)}
        style={{
          overscrollBehavior: 'contain',
          minHeight: 0,
          maxHeight: '100%'
        }}
      >
        <div
          ref={terminalRef}
          className="h-full w-full block"
          tabIndex={0}
          onMouseDown={focusTerminal}
          onClick={focusTerminal}
          onPaste={handlePasteBubble}
          onCopy={handleCopyBubble}
          style={{
            // CRITICAL: Prevent touch events from bubbling to parent on mobile
            touchAction: isMobile ? 'pan-y pinch-zoom' : 'auto',
            // Ensure element can receive focus for Ctrl/Cmd+V paste hotkeys
            outline: 'none'
          }}
        />
        <div
          ref={pasteSinkRef}
          contentEditable
          suppressContentEditableWarning
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '-10000px',
            top: 0,
            width: '1px',
            height: '1px',
            opacity: 0,
            overflow: 'hidden'
          }}
        />
        {remoteScrollThumb.visible && (
          <div
            ref={scrollbarTrackRef}
            className="absolute top-4 bottom-4 right-1 w-2 rounded-full bg-gray-700/35 cursor-pointer"
            onPointerDown={handleScrollbarPointerDown}
            onPointerMove={handleScrollbarPointerMove}
            onPointerUp={handleScrollbarPointerUp}
            onPointerCancel={handleScrollbarPointerUp}
            onPointerLeave={handleScrollbarPointerMove}
          >
            <div
              className="pointer-events-none absolute left-0 right-0 h-8 bg-blue-400/80 rounded-full shadow-sm"
              style={{
                top: `${remoteScrollThumb.topPercent}%`,
                transform: 'translateY(-50%)'
              }}
            />
          </div>
        )}
        {showScrollToBottom && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute bottom-4 right-4 z-50 rounded-full bg-blue-600/90 text-white px-4 py-2 text-xs shadow-lg hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-400"
          >
            Jump to bottom
          </button>
        )}
        {clipboardStatus && (
          <>
            <div className="sr-only" aria-live="polite">
              {clipboardStatus.message}
            </div>
            <div
              className="absolute bottom-4 left-4 z-50 rounded-full bg-gray-900/85 text-gray-100 px-3 py-2 text-[11px] shadow-lg border border-gray-700/60"
            >
              <span className="mr-2">{clipboardStatus.type === 'copy' ? '📋' : '📥'}</span>
              <span>{clipboardStatus.message}</span>
            </div>
          </>
        )}
        {showConnectionOverlay && connectionOverlayMessage && (
          <div className="absolute inset-0 flex items-center justify-center bg-terminal-bg/85 backdrop-blur-sm">
            <div className="text-center space-y-3 px-6 max-w-md pointer-events-auto">
              {overlayIsError ? (
                <>
                  <p className="text-sm font-medium text-red-300">{connectionOverlayMessage}</p>
                  {errorHint && (
                    <p className="text-xs text-red-200 leading-relaxed">{errorHint}</p>
                  )}
                  <div className="flex flex-col gap-2 mt-2 items-center">
                    <button
                      type="button"
                      onClick={handleManualReconnect}
                      className="px-4 py-2 text-xs font-semibold rounded-full bg-red-500/80 text-white hover:bg-red-400 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-300"
                    >
                      Reconnect
                    </button>
                    {policyStatusMessage && (
                      <p className="text-[11px] text-amber-300 leading-snug">{policyStatusMessage}</p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-300 mx-auto"></div>
                  <p className="text-sm text-gray-300">{connectionOverlayMessage}</p>
                  {policyStatusMessage && (
                    <p className="text-xs text-gray-400 max-w-sm mx-auto leading-relaxed">{policyStatusMessage}</p>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Notes / Prompt Builder Footer */}
      {!notesCollapsed && (
        <div
          className="border-t border-gray-700 bg-gray-900 flex flex-col"
          style={{
            height: isMobile ? '40vh' : '220px',
            minHeight: isMobile ? '40vh' : '220px',
            maxHeight: isMobile ? '40vh' : '220px',
            flexShrink: 0
          }}
        >
          <div className="px-4 py-2 border-b border-gray-700 bg-gray-800 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setFooterTab('notes')}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                  footerTab === 'notes'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                Notes
              </button>
              <button
                onClick={() => setFooterTab('prompt')}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                  footerTab === 'prompt'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                Prompt Builder
              </button>
            </div>
            <button
              onClick={() => setNotesCollapsed(true)}
              className="text-gray-400 hover:text-gray-200 transition-colors"
              title="Collapse footer"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>
          </div>
          {footerTab === 'notes' ? (
            <textarea
              id={`session-notes-${session.id}`}
              name={`sessionNotes-${session.id}`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Take notes while working with your agent..."
              className="flex-1 px-4 py-3 bg-gray-900 text-gray-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-inset font-mono overflow-y-auto"
              style={{
                minHeight: 0,
                maxHeight: '100%',
                height: '100%',
                WebkitOverflowScrolling: 'touch'
              }}
            />
          ) : (
            <div className="flex-1 flex flex-col">
              <textarea
                ref={promptTextareaRef}
                value={promptDraft}
                onChange={(e) => setPromptDraft(e.target.value)}
                onKeyDown={handlePromptKeyDown}
                placeholder="Compose your prompt here. Enter = send • Ctrl/Cmd+Enter = insert only • Shift+Enter = new line"
                className="flex-1 px-4 py-3 bg-gray-900 text-gray-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-inset font-mono overflow-y-auto"
                style={{
                  minHeight: 0,
                  maxHeight: '100%',
                  height: '100%',
                  WebkitOverflowScrolling: 'touch'
                }}
              />
              <div className="px-4 py-2 border-t border-gray-800 bg-gray-800 flex items-center justify-between">
                <p className="text-xs text-gray-400">
                  {promptDraft.length} character{promptDraft.length === 1 ? '' : 's'}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPromptDraft('')}
                    className="rounded-md border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:border-gray-600"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => handlePromptSubmit('insert')}
                    className="rounded-md border border-blue-500 px-3 py-1.5 text-xs font-medium text-blue-300 hover:bg-blue-500/10 disabled:opacity-50"
                    disabled={promptDraft.trim().length === 0}
                  >
                    Insert Only
                  </button>
                  <button
                    onClick={() => handlePromptSubmit('send')}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                    disabled={promptDraft.trim().length === 0}
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {notesCollapsed && (
        <div
          onClick={() => setNotesCollapsed(false)}
          className="border-t border-gray-700 bg-gray-800 px-4 py-2 cursor-pointer hover:bg-gray-750 transition-colors flex items-center gap-2"
          title="Click to expand footer"
        >
          <svg
            className="w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 15l7-7 7 7"
            />
          </svg>
          <span className="text-sm text-gray-400">
            {footerTab === 'prompt' ? 'Show Prompt Builder' : 'Show Session Notes'}
          </span>
        </div>
      )}
    </div>
  )
}

function ConnectionIndicator({
  isConnected,
  isLeader,
  policyMode,
  policyReason
}: {
  isConnected: boolean
  isLeader: boolean
  policyMode: 'normal' | 'replay-only'
  policyReason?: string | null
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <div
        className={`w-2 h-2 rounded-full ${
          isConnected ? 'bg-green-500' : 'bg-red-500'
        }`}
      />
      <span className="text-gray-400">
        {isConnected ? 'Connected' : 'Disconnected'}
      </span>
      <span
        className={`hidden md:inline ${
          isLeader ? 'text-blue-400' : 'text-gray-500'
        }`}
      >
        {isLeader ? 'Leader' : 'Viewer'}
      </span>
      {policyMode === 'replay-only' && (
        <span
          className="hidden md:inline text-amber-400"
          title={policyReason ?? 'Gateway is throttling history replay to protect performance'}
        >
          Limited
        </span>
      )}
    </div>
  )
}
