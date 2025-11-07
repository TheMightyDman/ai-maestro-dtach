import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { forwardMessage } from '@/lib/messageQueue'

const sessionNameSchema = z
  .string()
  .min(1, 'Session name is required')
  .regex(/^[A-Za-z0-9_-]+$/, 'Session name can only include letters, numbers, underscores, or hyphens')

const forwardSchema = z.object({
  messageId: z.string().min(1, 'messageId is required'),
  fromSession: sessionNameSchema,
  toSession: sessionNameSchema,
  forwardNote: z.string().optional(),
})

function validationError(error: z.ZodError) {
  const issues = error.issues.map((issue) => issue.message).join('; ')
  return NextResponse.json({ error: issues }, { status: 422 })
}

export async function POST(request: NextRequest) {
  try {
    const json = await request.json()
    const parsed = forwardSchema.safeParse(json)
    if (!parsed.success) {
      return validationError(parsed.error)
    }
    const { messageId, fromSession, toSession, forwardNote } = parsed.data

    // Forward the message
    const forwardedMessage = await forwardMessage(
      messageId,
      fromSession,
      toSession,
      forwardNote || undefined
    )

    return NextResponse.json({
      success: true,
      message: 'Message forwarded successfully',
      forwardedMessage: {
        id: forwardedMessage.id,
        to: forwardedMessage.to,
        subject: forwardedMessage.subject,
      },
    })
  } catch (error) {
    console.error('Error forwarding message:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to forward message' },
      { status: 500 }
    )
  }
}
