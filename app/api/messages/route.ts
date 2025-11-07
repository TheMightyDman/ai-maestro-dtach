import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import {
  sendMessage,
  listInboxMessages,
  listSentMessages,
  getSentCount,
  getMessage,
  markMessageAsRead,
  archiveMessage,
  deleteMessage,
  getUnreadCount,
  getMessageStats,
  listSessionsWithMessages,
} from '@/lib/messageQueue'
import type { Message } from '@/lib/messageQueue'

const sessionNameSchema = z
  .string()
  .min(1, 'Session name is required')
  .regex(/^[A-Za-z0-9_-]+$/, 'Session name can only include letters, numbers, underscores, or hyphens')

const prioritySchema = z.enum(['low', 'normal', 'high', 'urgent'])
const statusSchema = z.enum(['unread', 'read', 'archived'])
const messageTypeSchema = z.enum(['request', 'response', 'notification', 'update'])

const messageContentSchema = z.object({
  type: messageTypeSchema,
  message: z.string().min(1, 'Message body cannot be empty'),
  context: z.record(z.any()).optional(),
  attachments: z
    .array(
      z.object({
        name: z.string().min(1),
        path: z.string().min(1),
        type: z.string().min(1),
      })
    )
    .optional(),
})

const sendMessageSchema = z.object({
  from: sessionNameSchema,
  to: sessionNameSchema,
  subject: z.string().min(1).max(240),
  priority: prioritySchema.optional(),
  inReplyTo: z.string().optional(),
  content: messageContentSchema,
})

const forwardMessageSchema = z.object({
  messageId: z.string().min(1),
  fromSession: sessionNameSchema,
  toSession: sessionNameSchema,
  forwardNote: z.string().optional(),
})

function validationError(error: z.ZodError) {
  const issues = error.issues.map((issue) => issue.message).join('; ')
  return NextResponse.json({ error: issues }, { status: 422 })
}

/**
 * GET /api/messages?session=<sessionName>&status=<status>&from=<from>&box=<inbox|sent>
 * List messages for a session
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const sessionName = searchParams.get('session')
  const messageId = searchParams.get('id')
  const action = searchParams.get('action')
  const boxParam = searchParams.get('box') || 'inbox'
  const boxResult = z.enum(['inbox', 'sent']).safeParse(boxParam)
  if (!boxResult.success) {
    return validationError(boxResult.error)
  }
  const box = boxResult.data

  // Get specific message
  if (sessionName && messageId) {
    const validatedSession = sessionNameSchema.safeParse(sessionName)
    if (!validatedSession.success) {
      return validationError(validatedSession.error)
    }
    const message = await getMessage(validatedSession.data, messageId, box)
    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }
    return NextResponse.json(message)
  }

  // Get unread count (inbox only)
  if (action === 'unread-count' && sessionName) {
    const validatedSession = sessionNameSchema.safeParse(sessionName)
    if (!validatedSession.success) {
      return validationError(validatedSession.error)
    }
    const count = await getUnreadCount(validatedSession.data)
    return NextResponse.json({ count })
  }

  // Get sent count
  if (action === 'sent-count' && sessionName) {
    const validatedSession = sessionNameSchema.safeParse(sessionName)
    if (!validatedSession.success) {
      return validationError(validatedSession.error)
    }
    const count = await getSentCount(validatedSession.data)
    return NextResponse.json({ count })
  }

  // Get message stats
  if (action === 'stats' && sessionName) {
    const validatedSession = sessionNameSchema.safeParse(sessionName)
    if (!validatedSession.success) {
      return validationError(validatedSession.error)
    }
    const stats = await getMessageStats(validatedSession.data)
    return NextResponse.json(stats)
  }

  // List all sessions with messages
  if (action === 'sessions') {
    const sessions = await listSessionsWithMessages()
    return NextResponse.json({ sessions })
  }

  // List messages for a session
  if (!sessionName) {
    return NextResponse.json({ error: 'Session name required' }, { status: 400 })
  }
  const validatedSession = sessionNameSchema.safeParse(sessionName)
  if (!validatedSession.success) {
    return validationError(validatedSession.error)
  }
  const normalizedSession = validatedSession.data

  // List sent messages
  if (box === 'sent') {
    const priorityParam = searchParams.get('priority')
    const to = searchParams.get('to') || undefined
    const priority =
      priorityParam && prioritySchema.safeParse(priorityParam).success
        ? (priorityParam as Message['priority'])
        : undefined

    const messages = await listSentMessages(normalizedSession, { priority, to })
    return NextResponse.json({ messages })
  }

  // List inbox messages (default)
  const statusParam = searchParams.get('status')
  const priorityParam = searchParams.get('priority')
  const from = searchParams.get('from') || undefined

  const status =
    statusParam && statusSchema.safeParse(statusParam).success
      ? (statusParam as Message['status'])
      : undefined
  const priority =
    priorityParam && prioritySchema.safeParse(priorityParam).success
      ? (priorityParam as Message['priority'])
      : undefined

  const messages = await listInboxMessages(normalizedSession, { status, priority, from })
  return NextResponse.json({ messages })
}

/**
 * POST /api/messages
 * Send a new message
 */
export async function POST(request: NextRequest) {
  try {
    const json = await request.json()
    const parsed = sendMessageSchema.safeParse(json)
    if (!parsed.success) {
      return validationError(parsed.error)
    }
    const { from, to, subject, content, priority, inReplyTo } = parsed.data

    const message = await sendMessage(from, to, subject, content, { priority, inReplyTo })

    return NextResponse.json({ message }, { status: 201 })
  } catch (error) {
    console.error('Error sending message:', error)
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
  }
}

/**
 * PATCH /api/messages?session=<sessionName>&id=<messageId>&action=<action>
 * Update message status (mark as read, archive, etc.)
 */
export async function PATCH(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const sessionName = searchParams.get('session')
  const messageId = searchParams.get('id')
  const action = searchParams.get('action')

  if (!sessionName || !messageId) {
    return NextResponse.json(
      { error: 'Session name and message ID required' },
      { status: 400 }
    )
  }

  const validatedSession = sessionNameSchema.safeParse(sessionName)
  if (!validatedSession.success) {
    return validationError(validatedSession.error)
  }

  if (!action) {
    return NextResponse.json({ error: 'Action is required' }, { status: 400 })
  }

  try {
    let success = false

    switch (action) {
      case 'read':
        success = await markMessageAsRead(validatedSession.data, messageId)
        break
      case 'archive':
        success = await archiveMessage(validatedSession.data, messageId)
        break
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    if (!success) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error updating message:', error)
    return NextResponse.json({ error: 'Failed to update message' }, { status: 500 })
  }
}

/**
 * DELETE /api/messages?session=<sessionName>&id=<messageId>
 * Delete a message
 */
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const sessionName = searchParams.get('session')
  const messageId = searchParams.get('id')

  if (!sessionName || !messageId) {
    return NextResponse.json(
      { error: 'Session name and message ID required' },
      { status: 400 }
    )
  }

  const validatedSession = sessionNameSchema.safeParse(sessionName)
  if (!validatedSession.success) {
    return validationError(validatedSession.error)
  }

  try {
    const success = await deleteMessage(validatedSession.data, messageId)

    if (!success) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting message:', error)
    return NextResponse.json({ error: 'Failed to delete message' }, { status: 500 })
  }
}
