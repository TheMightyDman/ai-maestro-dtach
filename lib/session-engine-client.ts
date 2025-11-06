/**
 * Session Engine Client
 * TypeScript client for communicating with the AI Maestro session engine
 * via IPC (Unix domain socket)
 */

import { Socket } from 'net'

/**
 * Session metadata
 */
export interface SessionEntry {
  id: string
  socket_path: string
  cwd: string
  created_at: string
  last_activity: string
  env: Record<string, string>
  agent_id?: string
  status: 'active' | 'detached' | 'dead'
  pid?: number
}

/**
 * Create session request
 */
export interface CreateSessionRequest {
  name: string
  cwd: string
  env?: Record<string, string>
  shell?: string
}

/**
 * IPC request types
 */
export type IpcRequest =
  | { method: 'list_sessions'; params: {} }
  | { method: 'create_session'; params: CreateSessionRequest }
  | { method: 'attach_session'; params: { id: string } }
  | { method: 'delete_session'; params: { id: string } }
  | { method: 'get_metadata'; params: { id: string } }
  | { method: 'get_scrollback'; params: { id: string; lines: number } }

/**
 * IPC response
 */
export interface IpcResponse<T> {
  id: string
  result?: T
  error?: string
}

/**
 * List sessions response
 */
export interface ListSessionsResponse {
  sessions: SessionEntry[]
}

/**
 * Create session response
 */
export interface CreateSessionResponse {
  id: string
  socket_path: string
}

/**
 * Attach session response
 */
export interface AttachSessionResponse {
  socket_path: string
}

/**
 * Delete session response
 */
export interface DeleteSessionResponse {
  deleted: boolean
}

/**
 * Get scrollback response
 */
export interface GetScrollbackResponse {
  content: string
  total_lines: number
}

/**
 * Session engine client configuration
 */
export interface SessionEngineConfig {
  /** Path to Unix domain socket (default: /tmp/aimaestro-engine.sock) */
  socketPath?: string

  /** Connection timeout in milliseconds (default: 5000) */
  timeout?: number

  /** Number of retry attempts (default: 3) */
  retries?: number

  /** Retry delay in milliseconds (default: 1000) */
  retryDelay?: number
}

/**
 * Session engine client
 *
 * Communicates with the session engine daemon via Unix domain socket
 * using a simple JSON-RPC-style protocol.
 */
export class SessionEngineClient {
  private socketPath: string
  private timeout: number
  private retries: number
  private retryDelay: number
  private requestId: number = 0

  constructor(config: SessionEngineConfig = {}) {
    this.socketPath = config.socketPath || '/tmp/aimaestro-engine.sock'
    this.timeout = config.timeout || 5000
    this.retries = config.retries || 3
    this.retryDelay = config.retryDelay || 1000
  }

  /**
   * Send IPC request to session engine
   *
   * @param request IPC request
   * @returns Promise resolving to response
   */
  private async sendRequest<T>(request: IpcRequest): Promise<T> {
    const id = `req-${++this.requestId}`
    const message = JSON.stringify({ id, ...request })

    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.sendRequestOnce<T>(message, id)
      } catch (error) {
        lastError = error as Error

        if (attempt < this.retries) {
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, this.retryDelay))
        }
      }
    }

    throw lastError || new Error('Failed to send request')
  }

  /**
   * Send single request attempt
   */
  private sendRequestOnce<T>(message: string, requestId: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = new Socket()
      let responseData = ''

      // Set timeout
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('Request timeout'))
      }, this.timeout)

      // Connect to engine
      socket.connect(this.socketPath, () => {
        // Send request
        socket.write(message + '\n')
      })

      // Receive response
      socket.on('data', (data) => {
        responseData += data.toString()

        // Check if we have a complete JSON response
        try {
          const response: IpcResponse<T> = JSON.parse(responseData)

          clearTimeout(timer)
          socket.destroy()

          if (response.id !== requestId) {
            reject(new Error('Response ID mismatch'))
            return
          }

          if (response.error) {
            reject(new Error(response.error))
            return
          }

          if (response.result === undefined) {
            reject(new Error('Missing result in response'))
            return
          }

          resolve(response.result)
        } catch (e) {
          // Not a complete JSON yet, wait for more data
        }
      })

      socket.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })

      socket.on('close', () => {
        clearTimeout(timer)
        if (responseData === '') {
          reject(new Error('Connection closed without response'))
        }
      })
    })
  }

  /**
   * List all sessions
   *
   * @returns Promise resolving to session list
   */
  async listSessions(): Promise<SessionEntry[]> {
    const response = await this.sendRequest<ListSessionsResponse>({
      method: 'list_sessions',
      params: {},
    })
    return response.sessions
  }

  /**
   * Create a new session
   *
   * @param request Session creation request
   * @returns Promise resolving to created session info
   */
  async createSession(request: CreateSessionRequest): Promise<CreateSessionResponse> {
    return this.sendRequest<CreateSessionResponse>({
      method: 'create_session',
      params: request,
    })
  }

  /**
   * Get socket path for attaching to a session
   *
   * @param sessionId Session identifier
   * @returns Promise resolving to socket path
   */
  async attachSession(sessionId: string): Promise<AttachSessionResponse> {
    return this.sendRequest<AttachSessionResponse>({
      method: 'attach_session',
      params: { id: sessionId },
    })
  }

  /**
   * Delete a session
   *
   * @param sessionId Session identifier
   * @returns Promise resolving to deletion confirmation
   */
  async deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
    return this.sendRequest<DeleteSessionResponse>({
      method: 'delete_session',
      params: { id: sessionId },
    })
  }

  /**
   * Get session metadata
   *
   * @param sessionId Session identifier
   * @returns Promise resolving to session metadata
   */
  async getMetadata(sessionId: string): Promise<SessionEntry> {
    return this.sendRequest<SessionEntry>({
      method: 'get_metadata',
      params: { id: sessionId },
    })
  }

  /**
   * Get scrollback history
   *
   * @param sessionId Session identifier
   * @param lines Number of lines to retrieve
   * @returns Promise resolving to scrollback content
   */
  async getScrollback(sessionId: string, lines: number): Promise<GetScrollbackResponse> {
    return this.sendRequest<GetScrollbackResponse>({
      method: 'get_scrollback',
      params: { id: sessionId, lines },
    })
  }

  /**
   * Check if session engine is running
   *
   * @returns Promise resolving to true if engine is reachable
   */
  async isRunning(): Promise<boolean> {
    try {
      await this.listSessions()
      return true
    } catch {
      return false
    }
  }
}

/**
 * Singleton session engine client instance
 */
let clientInstance: SessionEngineClient | null = null

/**
 * Get or create session engine client
 *
 * @param config Optional configuration (only used on first call)
 * @returns Session engine client instance
 */
export function getSessionEngineClient(config?: SessionEngineConfig): SessionEngineClient {
  if (!clientInstance) {
    clientInstance = new SessionEngineClient(config)
  }
  return clientInstance
}

/**
 * Reset session engine client (useful for testing)
 */
export function resetSessionEngineClient(): void {
  clientInstance = null
}
