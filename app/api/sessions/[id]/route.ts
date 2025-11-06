import { NextResponse } from 'next/server'
import { unpersistSession } from '@/lib/session-persistence'
import { normalizeSessionName } from '@/lib/session-utils'
import { getSessionEngineClient } from '@/lib/session-engine-client'

export const dynamic = 'force-dynamic'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: rawSessionName } = await params

    const sessionName = normalizeSessionName(rawSessionName)

    if (!sessionName) {
      return NextResponse.json(
        { error: 'Invalid session name' },
        { status: 400 }
      )
    }

    // Check if session exists and delete via engine
    const client = getSessionEngineClient()
    try {
      await client.deleteSession(sessionName)
    } catch (error) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    // Remove from persistence
    unpersistSession(sessionName)

    return NextResponse.json({ success: true, name: sessionName })
  } catch (error) {
    console.error('Failed to delete session:', error)
    return NextResponse.json({ error: 'Failed to delete session' }, { status: 500 })
  }
}
