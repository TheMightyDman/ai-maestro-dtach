import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { getSessionEngineClient } from '../../../lib/session-engine-client'

export interface PtySessionOptions {
  readonly sessionName: string
  readonly socketPath?: string  // Optional: socket path from engine (if already known)
  readonly cols?: number
  readonly rows?: number
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly onData: (chunk: Buffer) => void
  readonly onExit: (code: number | null, signal: number | null) => void
}

export class PtySession {
  private readonly pty: IPty
  private paused = false

  private constructor(ptyProcess: IPty, onData: (chunk: Buffer) => void, onExit: (code: number | null, signal: number | null) => void) {
    ptyProcess.onData((data) => {
      onData(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'))
    })

    ptyProcess.onExit(({ exitCode, signal }) => {
      onExit(exitCode ?? null, signal ?? null)
    })

    this.pty = ptyProcess
  }

  /**
   * Create PtySession by attaching to existing session
   *
   * @param options Session options
   * @returns Promise resolving to PtySession instance
   */
  static async create(options: PtySessionOptions): Promise<PtySession> {
    const {
      sessionName,
      socketPath: providedSocketPath,
      cols = 80,
      rows = 24,
      cwd = process.env.HOME || process.cwd(),
      env = process.env,
      onData,
      onExit
    } = options

    // Get socket path from session engine if not provided
    let socketPath = providedSocketPath
    if (!socketPath) {
      const client = getSessionEngineClient()
      const response = await client.attachSession(sessionName)
      socketPath = response.socket_path
    }

    // Get dtach binary path
    const dtachPath = process.env.AIMAESTRO_DTACH_PATH || '/usr/local/bin/dtach'

    // Spawn dtach attach
    const ptyProcess = pty.spawn(dtachPath, ['-a', socketPath], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      encoding: null
    })

    return new PtySession(ptyProcess, onData, onExit)
  }

  write(data: string | Buffer): void {
    if (Buffer.isBuffer(data)) {
      this.pty.write(data.toString('utf8'))
    } else {
      this.pty.write(data)
    }
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows)
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    this.pty.pause()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.pty.resume()
  }

  dispose(): void {
    try {
      this.pty.kill()
    } catch {
      // ignore
    }
  }
}
