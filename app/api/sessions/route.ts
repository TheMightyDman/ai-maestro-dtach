import { NextResponse } from 'next/server'
import type { Session } from '@/types/session'
import { getAgentBySession } from '@/lib/agent-registry'
import { getGatewayActivity } from '@/lib/gateway'
import { getSessionEngineClient } from '@/lib/session-engine-client'

// Force this route to be dynamic (not statically generated at build time)
export const dynamic = 'force-dynamic'

const IS_DEV = process.env.NODE_ENV !== 'production'

export async function GET() {
  const routeStart = Date.now()
  if (IS_DEV) {
    console.info('[sessions] GET start')
  }
  try {
    const listStart = Date.now()
    const client = getSessionEngineClient()
    const engineSessions = await client.listSessions()
    if (IS_DEV) {
      console.info('[sessions] engine list-sessions', {
        durationMs: Date.now() - listStart,
        count: engineSessions.length
      })
    }

    if (engineSessions.length === 0) {
      if (IS_DEV) {
        console.info('[sessions] no sessions found', { durationMs: Date.now() - routeStart })
      }
      return NextResponse.json({ sessions: [] })
    }

    const activityStart = Date.now()
    const activityMap = await getGatewayActivity()
    if (IS_DEV) {
      console.info('[sessions] gateway activity fetched', {
        durationMs: Date.now() - activityStart,
        sessions: activityMap.size
      })
    }

    // Map engine sessions to API format
    const sessions: Session[] = engineSessions.map((engineSession) => {
      const name = engineSession.id

      // Get last activity from gateway or fallback to engine's last_activity
      let lastActivity: string
      let status: 'active' | 'idle' | 'disconnected'

      const activityTimestamp = activityMap.get(name)

      if (activityTimestamp) {
        lastActivity = new Date(activityTimestamp).toISOString()

        // Calculate if session is idle (no activity for 3+ seconds)
        const secondsSinceActivity = (Date.now() - activityTimestamp) / 1000
        status = secondsSinceActivity > 3 ? 'idle' : 'active'
      } else {
        // No gateway activity - use engine's last_activity
        lastActivity = engineSession.last_activity
        // Map engine status to API status
        status = engineSession.status === 'active' ? 'disconnected' : 'disconnected'
      }

      // Check if this session is linked to an agent
      const agent = getAgentBySession(name)

      return {
        id: name,
        name,
        workingDirectory: engineSession.cwd,
        status,
        createdAt: engineSession.created_at,
        lastActivity,
        windows: 1, // dtach doesn't have windows concept, always 1
        ...(agent && { agentId: agent.id })
      }
    })

    if (IS_DEV) {
      console.info('[sessions] success', {
        totalSessions: sessions.length,
        durationMs: Date.now() - routeStart
      })
    }
    return NextResponse.json({ sessions })
  } catch (error) {
    console.error('Failed to fetch sessions:', error)
    return NextResponse.json(
      { error: 'Failed to fetch sessions', sessions: [] },
      { status: 500 }
    )
  }
}
