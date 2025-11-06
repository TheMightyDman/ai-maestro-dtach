import { NextResponse } from 'next/server'
import { loadPersistedSessions, unpersistSession } from '@/lib/session-persistence'
import { normalizeSessionName } from '@/lib/session-utils'
import { getSessionEngineClient } from '@/lib/session-engine-client'

/**
 * GET /api/sessions/restore
 * Returns list of persisted sessions that can be restored
 */
export async function GET() {
  try {
    const persistedSessions = loadPersistedSessions()

    // Get currently active sessions from engine
    const client = getSessionEngineClient()
    const engineSessions = await client.listSessions()
    const activeSessionSet = new Set(engineSessions.map(s => s.id))

    // Filter to only sessions that don't currently exist
    const restorableSessions = persistedSessions.filter((session) => {
      const normalizedId = normalizeSessionName(session.id)
      if (!normalizedId) {
        return false
      }

      return activeSessionSet.has(normalizedId) === false
    })

    return NextResponse.json({
      sessions: restorableSessions,
      count: restorableSessions.length
    })
  } catch (error) {
    console.error('Failed to load restorable sessions:', error)
    return NextResponse.json({ error: 'Failed to load restorable sessions' }, { status: 500 })
  }
}

/**
 * POST /api/sessions/restore
 * Restores one or all persisted sessions
 */
export async function POST(request: Request) {
  try {
    const { sessionId, all } = await request.json()

    const persistedSessions = loadPersistedSessions()
    const sessionsToRestore = all
      ? persistedSessions
      : persistedSessions.filter(s => s.id === sessionId)

    if (sessionsToRestore.length === 0) {
      return NextResponse.json({ error: 'No sessions to restore' }, { status: 404 })
    }

    const client = getSessionEngineClient()
    const results = []

    for (const session of sessionsToRestore) {
      try {
        // Check if session already exists
        const sessionId = normalizeSessionName(session.id)

        if (!sessionId) {
          results.push({ sessionId: session.id, status: 'failed' })
          continue
        }

        // Check if session exists via engine
        let sessionExists = false
        try {
          await client.getMetadata(sessionId)
          sessionExists = true
        } catch {
          // Session doesn't exist, which is expected for restore
          sessionExists = false
        }

        if (!sessionExists) {
          // Create the session via engine
          await client.createSession({
            name: sessionId,
            cwd: session.workingDirectory,
            env: {}
          })
          results.push({ sessionId: sessionId, status: 'restored' })
        } else {
          results.push({ sessionId: sessionId, status: 'already_exists' })
        }
      } catch (error) {
        console.error(`Failed to restore session ${session.id}:`, error)
        const safeId = normalizeSessionName(session.id) || session.id
        results.push({ sessionId: safeId, status: 'failed' })
      }
    }

    const restored = results.filter(r => r.status === 'restored').length
    const failed = results.filter(r => r.status === 'failed').length
    const alreadyExisted = results.filter(r => r.status === 'already_exists').length

    return NextResponse.json({
      success: true,
      results,
      summary: {
        restored,
        failed,
        alreadyExisted,
        total: results.length
      }
    })
  } catch (error) {
    console.error('Failed to restore sessions:', error)
    return NextResponse.json({ error: 'Failed to restore sessions' }, { status: 500 })
  }
}

/**
 * DELETE /api/sessions/restore?sessionId=<id>
 * Permanently deletes a persisted session from storage
 */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const sessionId = searchParams.get('sessionId')

    if (!sessionId) {
      return NextResponse.json({ error: 'Session ID is required' }, { status: 400 })
    }

    const success = unpersistSession(sessionId)

    if (!success) {
      return NextResponse.json({ error: 'Failed to delete session' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to delete persisted session:', error)
    return NextResponse.json({ error: 'Failed to delete session' }, { status: 500 })
  }
}
