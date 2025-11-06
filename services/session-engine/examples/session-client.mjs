#!/usr/bin/env node
/**
 * AI Maestro Session Engine - Node.js Client Example
 *
 * Demonstrates how to communicate with the session engine via IPC.
 *
 * Usage:
 *   node session-client.mjs list
 *   node session-client.mjs create my-session /tmp
 *   node session-client.mjs info my-session
 *   node session-client.mjs delete my-session
 */

import { Socket } from 'net'

const SOCKET_PATH = process.env.AIMAESTRO_IPC_SOCKET || '/tmp/aimaestro-engine.sock'

/**
 * Send IPC request to session engine
 *
 * @param {string} method - IPC method name
 * @param {object} params - Method parameters
 * @returns {Promise<any>} Response result
 */
async function sendIpcRequest(method, params) {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    const requestId = `req-${Date.now()}-${Math.random()}`
    let responseData = ''

    // Timeout after 5 seconds
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('Request timeout'))
    }, 5000)

    socket.connect(SOCKET_PATH, () => {
      const request = JSON.stringify({ id: requestId, method, params })
      console.error(`→ ${request}`)
      socket.write(request + '\n')
    })

    socket.on('data', (data) => {
      responseData += data.toString()

      // Check if we have complete JSON
      try {
        const response = JSON.parse(responseData)
        clearTimeout(timeout)
        socket.destroy()

        console.error(`← ${responseData.trim()}`)

        if (response.id !== requestId) {
          reject(new Error(`Response ID mismatch: expected ${requestId}, got ${response.id}`))
          return
        }

        if (response.error) {
          reject(new Error(response.error))
        } else if (response.result === undefined) {
          reject(new Error('Missing result in response'))
        } else {
          resolve(response.result)
        }
      } catch (e) {
        // Not complete JSON yet, wait for more data
      }
    })

    socket.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    socket.on('close', () => {
      clearTimeout(timeout)
      if (responseData === '') {
        reject(new Error('Connection closed without response'))
      }
    })
  })
}

/**
 * Command: List all sessions
 */
async function cmdList() {
  const result = await sendIpcRequest('list_sessions', {})
  console.log(JSON.stringify(result, null, 2))
}

/**
 * Command: Create session
 */
async function cmdCreate(name, cwd = process.cwd()) {
  const result = await sendIpcRequest('create_session', {
    name,
    cwd,
    env: {}
  })
  console.log(JSON.stringify(result, null, 2))
}

/**
 * Command: Delete session
 */
async function cmdDelete(sessionId) {
  const result = await sendIpcRequest('delete_session', { id: sessionId })
  console.log(JSON.stringify(result, null, 2))
}

/**
 * Command: Get session metadata
 */
async function cmdInfo(sessionId) {
  const result = await sendIpcRequest('get_metadata', { id: sessionId })
  console.log(JSON.stringify(result, null, 2))
}

/**
 * Command: Get scrollback
 */
async function cmdScrollback(sessionId, lines = 100) {
  const result = await sendIpcRequest('get_scrollback', {
    id: sessionId,
    lines: parseInt(lines)
  })
  console.log(JSON.stringify(result, null, 2))
}

/**
 * Command: Health check
 */
async function cmdHealth() {
  try {
    const result = await sendIpcRequest('list_sessions', {})
    console.log('✓ Session engine is healthy')
    console.log(`  Sessions: ${result.sessions.length}`)
  } catch (error) {
    console.error('✗ Session engine is unhealthy:', error.message)
    process.exit(1)
  }
}

/**
 * Show usage
 */
function showUsage() {
  console.log('AI Maestro Session Engine - Node.js Client')
  console.log('')
  console.log('Usage: node session-client.mjs <command> [arguments]')
  console.log('')
  console.log('Commands:')
  console.log('  list                          List all sessions')
  console.log('  create <name> [dir]           Create new session')
  console.log('  delete <session-id>           Delete session')
  console.log('  info <session-id>             Get session metadata')
  console.log('  scrollback <session-id> [n]   Read last N lines of scrollback')
  console.log('  health                        Check engine health')
  console.log('  help                          Show this help')
  console.log('')
  console.log('Environment:')
  console.log('  AIMAESTRO_IPC_SOCKET          Path to engine socket (default: /tmp/aimaestro-engine.sock)')
  console.log('')
  console.log('Examples:')
  console.log('  node session-client.mjs list')
  console.log('  node session-client.mjs create my-session /tmp')
  console.log('  node session-client.mjs info my-session')
  console.log('  node session-client.mjs scrollback my-session 50')
  console.log('  node session-client.mjs delete my-session')
}

/**
 * Main entry point
 */
async function main() {
  const [,, command, ...args] = process.argv

  try {
    switch (command) {
      case 'list':
        await cmdList()
        break

      case 'create':
        if (!args[0]) {
          console.error('Error: Session name required')
          process.exit(1)
        }
        await cmdCreate(args[0], args[1])
        break

      case 'delete':
        if (!args[0]) {
          console.error('Error: Session ID required')
          process.exit(1)
        }
        await cmdDelete(args[0])
        break

      case 'info':
        if (!args[0]) {
          console.error('Error: Session ID required')
          process.exit(1)
        }
        await cmdInfo(args[0])
        break

      case 'scrollback':
        if (!args[0]) {
          console.error('Error: Session ID required')
          process.exit(1)
        }
        await cmdScrollback(args[0], args[1])
        break

      case 'health':
        await cmdHealth()
        break

      case 'help':
      case '--help':
      case '-h':
      case undefined:
        showUsage()
        break

      default:
        console.error(`Error: Unknown command '${command}'`)
        console.error("Run 'node session-client.mjs help' for usage")
        process.exit(1)
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

main()
