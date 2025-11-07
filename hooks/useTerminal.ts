'use client'

import { useRef, useCallback, useEffect } from 'react'
import type { Terminal, ITerminalAddon } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

const TERMINAL_DEBUG = process.env.NODE_ENV === 'development' || process.env.NEXT_PUBLIC_TERMINAL_DEBUG === 'true'

const debugLog = (...args: unknown[]) => {
  if (TERMINAL_DEBUG) {
    console.debug('[useTerminal]', ...args)
  }
}

function getCssPadding(): number {
  if (typeof window === 'undefined') {
    return 20
  }
  // Matches .xterm padding (10px desktop, 5px mobile) -> total horizontal/vertical padding
  return window.innerWidth < 768 ? 10 : 20
}

export interface UseTerminalOptions {
  fontSize?: number
  fontFamily?: string
  theme?: Record<string, string>
  sessionId?: string
  onRegister?: (helpers: { fit: () => void }) => void
  onUnregister?: () => void
  enableWebgl?: boolean
}

/**
 * Calculate exact terminal dimensions BEFORE xterm.js initializes
 * This eliminates race conditions where xterm calculates character cells
 * during CSS layout oscillations (795→694→686→771→795)
 */
function calculateTerminalDimensions(
  containerWidth: number,
  containerHeight: number,
  fontSize: number,
  fontFamily: string
): { cols: number; rows: number; cellWidth: number; cellHeight: number } {
  // Create a temporary off-screen element to measure character dimensions
  const measureElement = document.createElement('div')
  measureElement.style.position = 'absolute'
  measureElement.style.visibility = 'hidden'
  measureElement.style.whiteSpace = 'pre'
  measureElement.style.fontFamily = fontFamily
  measureElement.style.fontSize = `${fontSize}px`
  measureElement.style.lineHeight = '1.2'
  measureElement.style.fontWeight = '400'
  measureElement.textContent = 'X'.repeat(100) // Measure 100 characters for accuracy

  document.body.appendChild(measureElement)

  const rect = measureElement.getBoundingClientRect()
  const cellWidth = rect.width / 100 // Average character width
  const cellHeight = rect.height // Line height

  document.body.removeChild(measureElement)

  // Calculate how many columns/rows fit in the container
  // Account for xterm.js internal padding (2px on each side = 4px total)
  const XTERM_PADDING = 4
  const cssPadding = getCssPadding()
  const usableWidth = Math.max(0, containerWidth - XTERM_PADDING - cssPadding)
  const usableHeight = Math.max(0, containerHeight - XTERM_PADDING - cssPadding)

  const cols = Math.max(2, Math.floor(usableWidth / cellWidth))
  const rows = Math.max(1, Math.floor(usableHeight / cellHeight))


  return { cols, rows, cellWidth, cellHeight }
}

export function useTerminal(options: UseTerminalOptions = {}) {
  const terminalRef = useRef<Terminal | null>(null)
  const optionsRef = useRef(options)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const webglAddonRef = useRef<ITerminalAddon | null>(null)
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null)
const mouseSwallowDisposablesRef = useRef<{ h?: { dispose: () => void }, l?: { dispose: () => void } } | null>(null)
  const wheelHandlerRef = useRef<((ev: WheelEvent) => boolean) | null>(null)

  // Keep options ref up to date
  useEffect(() => {
    optionsRef.current = options
  }, [options])

  const detachWebgl = useCallback(() => {
    if (!webglAddonRef.current) {
      return
    }
    try {
      webglAddonRef.current.dispose()
    } catch {}
    webglAddonRef.current = null
    const sessionId = optionsRef.current.sessionId ?? 'unknown'
    debugLog(sessionId, 'webgl:disabled')
  }, [])

  const setSelectionFirstMode = useCallback((enabled: boolean) => {
    const term = terminalRef.current as any
    if (!term) return false
    // Dispose previous handlers
    if (mouseSwallowDisposablesRef.current) {
      try { mouseSwallowDisposablesRef.current.h?.dispose?.() } catch {}
      try { mouseSwallowDisposablesRef.current.l?.dispose?.() } catch {}
      mouseSwallowDisposablesRef.current = null
    }
    if (wheelHandlerRef.current) {
      try { term.attachCustomWheelEventHandler?.(undefined as any) } catch {}
      wheelHandlerRef.current = null
    }
    if (!enabled) {
      return true
    }

    const swallowed = new Set([1000, 1002, 1003, 1006])
    try {
      const h = term.parser?.registerCsiHandler?.({ prefix: '?', final: 'h' }, (params: number[]) => {
        return params?.some?.((p: number) => swallowed.has(p)) || false
      })
      const l = term.parser?.registerCsiHandler?.({ prefix: '?', final: 'l' }, (params: number[]) => {
        return params?.some?.((p: number) => swallowed.has(p)) || false
      })
      mouseSwallowDisposablesRef.current = { h, l }
      // Do not swallow wheel events inside xterm; allow our outer handler to manage scroll
      // This avoids conflicts during initialization where wheel would be ignored.
      return true
    } catch (e) {
      console.warn('[useTerminal] Failed to register mouse swallow handlers:', e)
      return false
    }
  }, [])

  const attachWebgl = useCallback(async (term: Terminal) => {
    if (webglAddonRef.current) {
      return true
    }
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl')
      const addon = new WebglAddon()
      term.loadAddon(addon)
      webglAddonRef.current = addon
      const sessionId = optionsRef.current.sessionId ?? 'unknown'
      debugLog(sessionId, 'webgl:enabled')
      return true
    } catch (error) {
      console.warn('[useTerminal] WebGL addon unavailable, falling back to canvas renderer:', error)
      webglAddonRef.current = null
      return false
    }
  }, [])

  const handleWebglContextLost = useCallback((event: Event) => {
    if (typeof event.preventDefault === 'function') {
      event.preventDefault()
    }
    const sessionId = optionsRef.current.sessionId ?? 'unknown'
    console.warn(`[useTerminal] WebGL context lost for session ${sessionId}, switching to canvas renderer`)
    detachWebgl()
  }, [detachWebgl])

  const fitTerminal = useCallback(() => {
    const term = terminalRef.current
    if (!term) {
      return
    }

    const runFit = () => {
      try {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit()
        } else {
          const sessionId = optionsRef.current.sessionId ?? 'unknown'
          const container = term.element?.parentElement
          const host = container?.parentElement ?? container
          if (!host) {
            debugLog(sessionId, 'fit:skip-no-host')
            return
          }
          const rect = host.getBoundingClientRect()
          const containerWidth = Math.floor(rect.width)
          const containerHeight = Math.floor(rect.height)

          if (containerWidth === 0 || containerHeight === 0) {
            window.requestAnimationFrame(runFit)
            return
          }

          const { cols: newCols, rows: newRows } = calculateTerminalDimensions(
            containerWidth,
            containerHeight,
            term.options.fontSize as number,
            term.options.fontFamily as string
          )

          debugLog(sessionId, 'fitTerminal-manual', `${term.cols}x${term.rows}`, '->', `${newCols}x${newRows}`)
          term.resize(newCols, newRows)
        }
      } catch (error) {
        console.error('fitTerminal failed:', error)
        return
      }

      try {
        term.clearSelection()
        term.refresh(0, term.rows - 1)
      } catch {}
    }

    runFit()
  }, [])

  const initializeTerminal = useCallback(async (container: HTMLElement) => {
    // Clean up existing terminal
    if (terminalRef.current) {
      terminalRef.current.dispose()
      terminalRef.current = null
    }

    // Clear the container completely
    while (container.firstChild) {
      container.removeChild(container.firstChild)
    }

    // Get container dimensions - THIS IS THE STABLE SIZE WE TRUST
    const hostElement = container.parentElement ?? container
    const containerRect = hostElement.getBoundingClientRect()
    const containerWidth = Math.floor(containerRect.width)
    const containerHeight = Math.floor(containerRect.height)
    const sessionId = optionsRef.current.sessionId ?? 'unknown'
    debugLog(sessionId, 'init:container', `${containerWidth}x${containerHeight}`)


    // CRITICAL: Pre-calculate terminal dimensions BEFORE creating terminal
    const fontSize = optionsRef.current.fontSize || 16
    const fontFamily = optionsRef.current.fontFamily || '"SF Mono", "Monaco", "Cascadia Code", "Roboto Mono", "Courier New", monospace'

    if (typeof document !== 'undefined' && 'fonts' in document) {
      try {
        await (document as unknown as { fonts: { ready: Promise<void> } }).fonts.ready
      } catch (error) {
        debugLog(sessionId, 'fonts:ready-error', error)
      }
    }

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve())
      })
    }

    const { cols, rows, cellWidth, cellHeight } = calculateTerminalDimensions(
      containerWidth,
      containerHeight,
      fontSize,
      fontFamily
    )

    // Dynamic imports for browser-only code

    const { Terminal } = await import('@xterm/xterm')
    const { FitAddon } = await import('@xterm/addon-fit')
    const { WebLinksAddon } = await import('@xterm/addon-web-links')
    const { ClipboardAddon } = await import('@xterm/addon-clipboard')
    const { Unicode11Addon } = await import('@xterm/addon-unicode11')

    // Create terminal instance with PRE-CALCULATED dimensions
    const terminal = new Terminal({
      // CRITICAL: Set exact dimensions upfront - no guessing
      cols,
      rows,
      cursorBlink: true,
      allowProposedApi: true,
      fontSize,
      fontFamily,
      fontWeight: '400',
      fontWeightBold: '700',
      lineHeight: 1.2,
      theme: optionsRef.current.theme || {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#aeafad',
        selectionBackground: 'rgba(100,116,139,0.35)',    // Semi-transparent for clear overlay
        selectionForeground: '#ffffff',     // White text when selected
        selectionInactiveBackground: 'rgba(71,85,105,0.28)', // Softer highlight when unfocused
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#dcdcaa',  // Softer yellow (VS Code default)
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#dcdcaa',  // Match normal yellow for consistency
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#ffffff',
      },
      scrollback: 50000,
      // CRITICAL: Must be false for PTY connections
      // PTY and tmux handle line endings correctly - setting this to true causes
      // Claude Code status updates (using \r) to create new lines instead of overwriting
      convertEol: false,
      allowTransparency: false,
      scrollSensitivity: 1,
      fastScrollSensitivity: 5,
      // Ensure scrollback works in all modes
      altClickMovesCursor: false,
      // Support alternate screen buffer (used by Claude Code, vim, etc.)
      windowOptions: {
        setWinLines: true,
        // Allow OSC 52 to set host clipboard (tmux/vim copy to system clipboard)
        setWinClipboard: true,
      },
      // Disable Windows mode - we're on Unix/macOS
      windowsMode: false,
      // CRITICAL: This might help with carriage return handling
      macOptionIsMeta: true,
      // macOS: force selection when Option is held, even if mouse reporting is on
      macOptionClickForcesSelection: true,
      // Right-click should not change selection; keep current highlight visible
      rightClickSelectsWord: false,
    })

    // Initialize addons
    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    const unicodeAddon = new Unicode11Addon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.loadAddon(unicodeAddon)

    try {
      terminal.unicode.activeVersion = '11'
    } catch (error) {
      console.warn(`[useTerminal] Failed to activate Unicode11 addon for session ${sessionId}:`, error)
    }

    terminalRef.current = terminal

    // Default to selection-first: prevent programs from stealing mouse
    setSelectionFirstMode(true)

    if (optionsRef.current.enableWebgl !== false) {
      await attachWebgl(terminal)
    } else {
      detachWebgl()
    }

    // Load clipboard addon for copy/paste support
    try {
      const clipboardAddon = new ClipboardAddon()
      terminal.loadAddon(clipboardAddon)
    } catch (e) {
      console.error(`❌ Failed to load clipboard addon for session ${optionsRef.current.sessionId}:`, e)
    }

    // Open terminal in container
    terminal.open(container)

    const canvas = container.querySelector('canvas') as HTMLCanvasElement | null
    if (webglCanvasRef.current && webglCanvasRef.current !== canvas) {
      webglCanvasRef.current.removeEventListener('webglcontextlost', handleWebglContextLost)
    }
    webglCanvasRef.current = canvas
    if (canvas) {
      canvas.addEventListener('webglcontextlost', handleWebglContextLost, { once: true })
    }

    // Fix xterm.js helper textarea missing id/name (causes browser console warnings)
    // xterm.js creates a hidden textarea for input handling but doesn't add id/name
    const helperTextarea = container.querySelector('.xterm-helper-textarea')
    if (helperTextarea && optionsRef.current.sessionId) {
      helperTextarea.setAttribute('id', `xterm-helper-${optionsRef.current.sessionId}`)
      helperTextarea.setAttribute('name', `xterm-helper-${optionsRef.current.sessionId}`)
    }

    // CRITICAL: Verify that xterm.js respected our pre-calculated dimensions
    if (terminal.cols !== cols || terminal.rows !== rows) {
      console.warn(`⚠️ [INIT] Terminal dimensions mismatch! Expected ${cols}x${rows}, got ${terminal.cols}x${terminal.rows}`)
      debugLog(sessionId, 'init:mismatch', `${cols}x${rows}`, '->', `${terminal.cols}x${terminal.rows}`)
      // Force dimensions to match our calculation
      terminal.resize(cols, rows)
    }

    // Fit using addon to ensure exact dimensions
    try {
      fitAddon.fit()
    } catch (e) {
      console.warn('FitAddon.fit() failed during init:', e)
    }
    fitAddonRef.current = fitAddon

    // NOTE: We don't scroll to bottom here because history hasn't loaded yet
    // Scrolling happens in TerminalView after 'history-complete' message

    // Store references
    // Register with global terminal registry
    optionsRef.current.onRegister?.({ fit: fitTerminal })

    // Handle window resize - for actual window resizes
    let resizeTimeout: NodeJS.Timeout
    let prevWidth = containerWidth
    let prevHeight = containerHeight

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      const newWidth = Math.floor(entry.contentRect.width)
      const newHeight = Math.floor(entry.contentRect.height)

      // Ignore micro-oscillations (< 5px)
      const widthDiff = Math.abs(newWidth - prevWidth)
      const heightDiff = Math.abs(newHeight - prevHeight)

      if (widthDiff < 5 && heightDiff < 5) {
        // Skip insignificant changes
        return
      }
      const previousWidth = prevWidth
      const previousHeight = prevHeight
      prevWidth = newWidth
      prevHeight = newHeight

      clearTimeout(resizeTimeout)
      const targetWidth = newWidth
      const targetHeight = newHeight

      resizeTimeout = setTimeout(() => {
        debugLog(sessionId, 'resizeObserver', `${previousWidth}x${previousHeight}`, '->', `${targetWidth}x${targetHeight}`)
        fitTerminal()
      }, 50) // Debounce to avoid thrashing during resize
    })

    resizeObserver.observe(hostElement)

    // Keyboard shortcuts: copy on selection, scrolling helpers
    terminal.attachCustomKeyEventHandler((event) => {
      // Copy behavior: If there is a selection, Ctrl/Cmd+C copies instead of sending ^C
      const isCopyCombo = (event.ctrlKey || event.metaKey) && (event.key === 'c' || event.key === 'C')
      if (isCopyCombo && (terminal.hasSelection?.() ?? false)) {
        try {
          // Prefer execCommand to trigger xterm's 'copy' handler, which sets correct data
          const ok = document.execCommand('copy')
          if (!ok) {
            const selection = (terminal as any).getSelection?.() ?? ''
            if (selection && navigator.clipboard?.writeText) {
              void navigator.clipboard.writeText(selection)
            }
          }
        } catch {
          const selection = (terminal as any).getSelection?.() ?? ''
          if (selection && navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(selection)
          }
        }
        // Prevent ^C from reaching the PTY when copying
        return false
      }

      // Calculate scroll amount based on terminal height (scroll by page)
      const scrollAmount = Math.max(5, Math.floor(terminal.rows / 2))

      // Shift + Page Up - Scroll up by page
      if (event.shiftKey && event.key === 'PageUp') {
        terminal.scrollLines(-scrollAmount)
        return false
      }
      // Shift + Page Down - Scroll down by page
      if (event.shiftKey && event.key === 'PageDown') {
        terminal.scrollLines(scrollAmount)
        return false
      }
      // Shift + Arrow Up - Scroll up 5 lines
      if (event.shiftKey && event.key === 'ArrowUp') {
        terminal.scrollLines(-5)
        return false
      }
      // Shift + Arrow Down - Scroll down 5 lines
      if (event.shiftKey && event.key === 'ArrowDown') {
        terminal.scrollLines(5)
        return false
      }
      // Shift + Home - Scroll to top
      if (event.shiftKey && event.key === 'Home') {
        terminal.scrollToTop()
        return false
      }
      // Shift + End - Scroll to bottom
      if (event.shiftKey && event.key === 'End') {
        terminal.scrollToBottom()
        return false
      }
      return true
    })

    // Cleanup function
    return () => {
      resizeObserver.disconnect()
      if (optionsRef.current.onUnregister) {
        optionsRef.current.onUnregister()
      }
      // Clean parser hooks
      if (mouseSwallowDisposablesRef.current) {
        try { mouseSwallowDisposablesRef.current.h?.dispose?.() } catch {}
        try { mouseSwallowDisposablesRef.current.l?.dispose?.() } catch {}
        mouseSwallowDisposablesRef.current = null
      }
      if (wheelHandlerRef.current) {
        try { terminal.attachCustomWheelEventHandler?.(undefined as any) } catch {}
        wheelHandlerRef.current = null
      }
      if (webglCanvasRef.current) {
        webglCanvasRef.current.removeEventListener('webglcontextlost', handleWebglContextLost)
        webglCanvasRef.current = null
      }
      detachWebgl()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [attachWebgl, detachWebgl, fitTerminal, handleWebglContextLost])

  const disposeTerminal = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  const clearTerminal = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.clear()
    }
  }, [])

  const writeToTerminal = useCallback((data: string) => {
    if (terminalRef.current) {
      terminalRef.current.write(data)
    }
  }, [])

  const setWebglEnabled = useCallback(async (enabled: boolean) => {
    const term = terminalRef.current
    if (!term) {
      if (!enabled) {
        detachWebgl()
        return true
      }
      return false
    }

    if (!enabled) {
      detachWebgl()
      return true
    }

    const attached = await attachWebgl(term)
    if (attached) {
      const canvas = term.element?.querySelector('canvas') as HTMLCanvasElement | null
      if (canvas) {
        if (webglCanvasRef.current && webglCanvasRef.current !== canvas) {
          webglCanvasRef.current.removeEventListener('webglcontextlost', handleWebglContextLost)
        }
        webglCanvasRef.current = canvas
        canvas.addEventListener('webglcontextlost', handleWebglContextLost, { once: true })
      }
    }
    return attached
  }, [attachWebgl, detachWebgl, handleWebglContextLost])

  return {
    terminal: terminalRef.current,
    initializeTerminal,
    disposeTerminal,
    fitTerminal,
    clearTerminal,
    writeToTerminal,
    setWebglEnabled,
    setSelectionFirstMode,
  }
}
