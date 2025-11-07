import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'node:crypto'

export interface Message {
  id: string
  from: string
  to: string
  timestamp: string
  subject: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  status: 'unread' | 'read' | 'archived'
  content: {
    type: 'request' | 'response' | 'notification' | 'update'
    message: string
    context?: Record<string, any>
    attachments?: Array<{
      name: string
      path: string
      type: string
    }>
  }
  inReplyTo?: string
  forwardedFrom?: {
    originalMessageId: string
    originalFrom: string
    originalTo: string
    originalTimestamp: string
    forwardedBy: string
    forwardedAt: string
    forwardNote?: string
  }
}

export interface MessageSummary {
  id: string
  from: string
  to: string
  timestamp: string
  subject: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  status: 'unread' | 'read' | 'archived'
  type: 'request' | 'response' | 'notification' | 'update'
  preview: string
}

const SESSION_NAME_REGEX = /^[A-Za-z0-9_-]+$/
const SUBJECT_MAX_LENGTH = 240
const MESSAGE_PREVIEW_LENGTH = 160
const MESSAGE_BODY_MAX_LENGTH = Number(process.env.AIMAESTRO_MESSAGE_MAX_CHARS ?? 20000)

const MESSAGE_DIR = (() => {
  const customDir = process.env.AIMAESTRO_MESSAGE_DIR
  if (customDir) {
    return path.resolve(customDir)
  }
  return path.join(os.homedir(), '.aimaestro', 'messages')
})()

function assertSessionName(value: string, field: 'from' | 'to' | 'session'): void {
  if (!value || !SESSION_NAME_REGEX.test(value)) {
    throw new Error(`Invalid ${field} session name: "${value}". Use letters, numbers, _, or -.`)
  }
}

function sanitizeSubject(subject: string): string {
  const trimmed = subject?.trim?.() ?? ''
  if (!trimmed) {
    throw new Error('Subject cannot be empty')
  }
  if (trimmed.length > SUBJECT_MAX_LENGTH) {
    throw new Error(`Subject is too long (max ${SUBJECT_MAX_LENGTH} characters)`)
  }
  return trimmed
}

function sanitizeContent(content: Message['content']): Message['content'] {
  if (!content || typeof content.message !== 'string' || !content.type) {
    throw new Error('Content must include type and message')
  }
  const trimmedMessage = content.message.trim()
  if (!trimmedMessage) {
    throw new Error('Content message cannot be empty')
  }
  if (trimmedMessage.length > MESSAGE_BODY_MAX_LENGTH) {
    throw new Error(`Content message exceeds ${MESSAGE_BODY_MAX_LENGTH} characters`)
  }
  return {
    ...content,
    message: trimmedMessage
  }
}

function buildPreview(message: string): string {
  if (!message) {
    return ''
  }
  const normalized = message.replace(/\s+/g, ' ').trim()
  if (normalized.length <= MESSAGE_PREVIEW_LENGTH) {
    return normalized
  }
  return `${normalized.slice(0, MESSAGE_PREVIEW_LENGTH - 1)}…`
}

/**
 * Ensures the message directory structure exists
 */
export async function ensureMessageDirectories(): Promise<void> {
  const dirs = [
    MESSAGE_DIR,
    path.join(MESSAGE_DIR, 'inbox'),
    path.join(MESSAGE_DIR, 'sent'),
    path.join(MESSAGE_DIR, 'archived'),
  ]

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true })
  }
}

/**
 * Generate a unique message ID
 */
function generateMessageId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return `msg-${crypto.randomUUID()}`
  }
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `msg-${timestamp}-${random}`
}

/**
 * Get the inbox directory for a session
 */
function getInboxDir(sessionName: string): string {
  return path.join(MESSAGE_DIR, 'inbox', sessionName)
}

/**
 * Get the sent directory for a session
 */
function getSentDir(sessionName: string): string {
  return path.join(MESSAGE_DIR, 'sent', sessionName)
}

/**
 * Get the archived directory for a session
 */
function getArchivedDir(sessionName: string): string {
  return path.join(MESSAGE_DIR, 'archived', sessionName)
}

/**
 * Ensure session-specific directories exist
 */
async function ensureSessionDirectories(sessionName: string): Promise<void> {
  await fs.mkdir(getInboxDir(sessionName), { recursive: true })
  await fs.mkdir(getSentDir(sessionName), { recursive: true })
  await fs.mkdir(getArchivedDir(sessionName), { recursive: true })
}

async function writeMessageFile(filePath: string, message: Message): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(message, null, 2))
}

async function readMessageIfExists(filePath: string): Promise<Message | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(content)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/**
 * Send a message from one session to another
 */
export async function sendMessage(
  from: string,
  to: string,
  subject: string,
  content: Message['content'],
  options?: {
    priority?: Message['priority']
    inReplyTo?: string
  }
): Promise<Message> {
  assertSessionName(from, 'from')
  assertSessionName(to, 'to')
  const safeSubject = sanitizeSubject(subject)
  const safeContent = sanitizeContent(content)

  await ensureMessageDirectories()
  await ensureSessionDirectories(from)
  await ensureSessionDirectories(to)

  const message: Message = {
    id: generateMessageId(),
    from,
    to,
    timestamp: new Date().toISOString(),
    subject: safeSubject,
    priority: options?.priority || 'normal',
    status: 'unread',
    content: safeContent,
    inReplyTo: options?.inReplyTo,
  }

  // Write to recipient's inbox
  const inboxPath = path.join(getInboxDir(to), `${message.id}.json`)
  await writeMessageFile(inboxPath, message)

  // Write to sender's sent folder
  const sentPath = path.join(getSentDir(from), `${message.id}.json`)
  await writeMessageFile(sentPath, message)

  return message
}

/**
 * Forward a message to another session
 */
export async function forwardMessage(
  originalMessageId: string,
  fromSession: string,
  toSession: string,
  forwardNote?: string
): Promise<Message> {
  assertSessionName(fromSession, 'from')
  assertSessionName(toSession, 'to')
  if (fromSession === toSession) {
    throw new Error('Cannot forward to the same session')
  }

  // Get the original message
  const originalMessage = await getMessage(fromSession, originalMessageId)
  if (!originalMessage) {
    throw new Error(`Message ${originalMessageId} not found`)
  }

  await ensureMessageDirectories()
  await ensureSessionDirectories(fromSession)
  await ensureSessionDirectories(toSession)

  // Build forwarded content
  let forwardedContent = ''
  const trimmedNote = forwardNote?.trim()
  if (trimmedNote) {
    forwardedContent += `${trimmedNote}\n\n`
  }
  forwardedContent += `--- Forwarded Message ---\n`
  forwardedContent += `From: ${originalMessage.from}\n`
  forwardedContent += `To: ${originalMessage.to}\n`
  forwardedContent += `Sent: ${new Date(originalMessage.timestamp).toLocaleString()}\n`
  forwardedContent += `Subject: ${originalMessage.subject}\n\n`
  forwardedContent += `${originalMessage.content.message}\n`
  forwardedContent += `--- End of Forwarded Message ---`

  // Create forwarded message
  const forwardedMessage: Message = {
    id: generateMessageId(),
    from: fromSession,
    to: toSession,
    timestamp: new Date().toISOString(),
    subject: sanitizeSubject(`Fwd: ${originalMessage.subject}`),
    priority: originalMessage.priority,
    status: 'unread',
    content: {
      type: 'notification',
      message: forwardedContent,
    },
    forwardedFrom: {
      originalMessageId: originalMessage.id,
      originalFrom: originalMessage.from,
      originalTo: originalMessage.to,
      originalTimestamp: originalMessage.timestamp,
      forwardedBy: fromSession,
      forwardedAt: new Date().toISOString(),
      forwardNote: trimmedNote,
    },
  }

  // Write to recipient's inbox
  const inboxPath = path.join(getInboxDir(toSession), `${forwardedMessage.id}.json`)
  await writeMessageFile(inboxPath, forwardedMessage)

  // Write to sender's sent folder (mark as forwarded)
  const sentPath = path.join(getSentDir(fromSession), `fwd_${forwardedMessage.id}.json`)
  await writeMessageFile(sentPath, forwardedMessage)

  return forwardedMessage
}

/**
 * List messages in a session's inbox
 */
export async function listInboxMessages(
  sessionName: string,
  filter?: {
    status?: Message['status']
    priority?: Message['priority']
    from?: string
  }
): Promise<MessageSummary[]> {
  await ensureSessionDirectories(sessionName)
  const inboxDir = getInboxDir(sessionName)

  let files: string[]
  try {
    files = await fs.readdir(inboxDir)
  } catch (error) {
    return []
  }

  const messages: MessageSummary[] = []

  for (const file of files) {
    if (!file.endsWith('.json')) continue

    const filePath = path.join(inboxDir, file)
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const message: Message = JSON.parse(content)

      // Apply filters
      if (filter?.status && message.status !== filter.status) continue
      if (filter?.priority && message.priority !== filter.priority) continue
      if (filter?.from && message.from !== filter.from) continue

      messages.push({
        id: message.id,
        from: message.from,
        to: message.to,
        timestamp: message.timestamp,
        subject: message.subject,
        priority: message.priority,
        status: message.status,
        type: message.content.type,
        preview: buildPreview(message.content.message),
      })
    } catch (error) {
      console.error(`Error reading message file ${file}:`, error)
    }
  }

  // Sort by timestamp (newest first)
  messages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  return messages
}

/**
 * List messages in a session's sent folder (outbox)
 */
export async function listSentMessages(
  sessionName: string,
  filter?: {
    priority?: Message['priority']
    to?: string
  }
): Promise<MessageSummary[]> {
  await ensureSessionDirectories(sessionName)
  const sentDir = getSentDir(sessionName)

  let files: string[]
  try {
    files = await fs.readdir(sentDir)
  } catch (error) {
    return []
  }

  const messages: MessageSummary[] = []

  for (const file of files) {
    if (!file.endsWith('.json')) continue

    const filePath = path.join(sentDir, file)
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const message: Message = JSON.parse(content)

      // Apply filters
      if (filter?.priority && message.priority !== filter.priority) continue
      if (filter?.to && message.to !== filter.to) continue

      messages.push({
        id: message.id,
        from: message.from,
        to: message.to,
        timestamp: message.timestamp,
        subject: message.subject,
        priority: message.priority,
        status: message.status,
        type: message.content.type,
        preview: buildPreview(message.content.message),
      })
    } catch (error) {
      console.error(`Error reading sent message file ${file}:`, error)
    }
  }

  // Sort by timestamp (newest first)
  messages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  return messages
}

/**
 * Get sent message count for a session
 */
export async function getSentCount(sessionName: string): Promise<number> {
  const messages = await listSentMessages(sessionName)
  return messages.length
}

/**
 * Get a specific message by ID from inbox or sent folder
 */
export async function getMessage(
  sessionName: string,
  messageId: string,
  box: 'inbox' | 'sent' = 'inbox'
): Promise<Message | null> {
  await ensureSessionDirectories(sessionName)
  const primaryDir = box === 'sent' ? getSentDir(sessionName) : getInboxDir(sessionName)
  const fallbackDir = box === 'sent' ? getInboxDir(sessionName) : getSentDir(sessionName)
  const archivedDir = getArchivedDir(sessionName)

  const primary = await readMessageIfExists(path.join(primaryDir, `${messageId}.json`))
  if (primary) return primary

  const secondary = await readMessageIfExists(path.join(fallbackDir, `${messageId}.json`))
  if (secondary) return secondary

  return readMessageIfExists(path.join(archivedDir, `${messageId}.json`))
}

/**
 * Mark a message as read
 */
export async function markMessageAsRead(sessionName: string, messageId: string): Promise<boolean> {
  await ensureSessionDirectories(sessionName)
  const inboxPath = path.join(getInboxDir(sessionName), `${messageId}.json`)
  const message = await readMessageIfExists(inboxPath)
  if (!message) {
    return false
  }
  if (message.status === 'read') {
    return true
  }
  message.status = 'read'
  await writeMessageFile(inboxPath, message)
  return true
}

/**
 * Archive a message (move from inbox to archived)
 */
export async function archiveMessage(sessionName: string, messageId: string): Promise<boolean> {
  await ensureSessionDirectories(sessionName)
  const inboxPath = path.join(getInboxDir(sessionName), `${messageId}.json`)
  const archivedPath = path.join(getArchivedDir(sessionName), `${messageId}.json`)

  const message = await readMessageIfExists(inboxPath)
  if (!message) {
    return false
  }

  message.status = 'archived'
  await writeMessageFile(archivedPath, message)
  await fs.unlink(inboxPath)

  return true
}

/**
 * Delete a message permanently
 */
export async function deleteMessage(sessionName: string, messageId: string): Promise<boolean> {
  await ensureSessionDirectories(sessionName)
  const targets = [
    path.join(getInboxDir(sessionName), `${messageId}.json`),
    path.join(getArchivedDir(sessionName), `${messageId}.json`),
    path.join(getSentDir(sessionName), `${messageId}.json`)
  ]

  let deleted = false
  for (const filePath of targets) {
    try {
      await fs.unlink(filePath)
      deleted = true
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        continue
      }
      throw error
    }
  }
  return deleted
}

/**
 * Get unread message count for a session
 */
export async function getUnreadCount(sessionName: string): Promise<number> {
  const messages = await listInboxMessages(sessionName, { status: 'unread' })
  return messages.length
}

/**
 * List all sessions with messages
 */
export async function listSessionsWithMessages(): Promise<string[]> {
  await ensureMessageDirectories()
  const inboxDir = path.join(MESSAGE_DIR, 'inbox')

  try {
    const sessions = await fs.readdir(inboxDir)
    return sessions
  } catch (error) {
    return []
  }
}

/**
 * Get message statistics for a session
 */
export async function getMessageStats(sessionName: string): Promise<{
  unread: number
  total: number
  byPriority: Record<string, number>
}> {
  const messages = await listInboxMessages(sessionName)

  const stats = {
    unread: messages.filter(m => m.status === 'unread').length,
    total: messages.length,
    byPriority: {
      low: 0,
      normal: 0,
      high: 0,
      urgent: 0,
    },
  }

  messages.forEach(m => {
    stats.byPriority[m.priority]++
  })

  return stats
}

export async function resetMessageStoreForTests(): Promise<void> {
  if (!process.env.NODE_ENV || process.env.NODE_ENV === 'test') {
    await fs.rm(MESSAGE_DIR, { recursive: true, force: true })
  }
}
