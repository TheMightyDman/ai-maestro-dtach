import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'

const setupPromise = (async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aimaestro-msg-'))
  process.env.AIMAESTRO_MESSAGE_DIR = path.join(tempRoot, 'messages')
  process.env.NODE_ENV = 'test'
  const messageQueue = await import('../lib/messageQueue')
  return { tempRoot, messageQueue }
})()

after(async () => {
  const { tempRoot } = await setupPromise
  await fs.rm(tempRoot, { recursive: true, force: true })
})

test('send, list, mark read, archive, and delete flow', async (t) => {
  const { messageQueue } = await setupPromise
  const {
    sendMessage,
    listInboxMessages,
    listSentMessages,
    getMessage,
    markMessageAsRead,
    archiveMessage,
    deleteMessage,
    getUnreadCount,
    resetMessageStoreForTests,
  } = messageQueue

  await resetMessageStoreForTests()
  const created = await sendMessage('alpha', 'beta', 'Test Subject', {
    type: 'request',
    message: 'Hello beta, please review the spec.',
  })

  const inbox = await listInboxMessages('beta')
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].status, 'unread')

  const sent = await listSentMessages('alpha')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].subject, 'Test Subject')

  const unreadBefore = await getUnreadCount('beta')
  assert.equal(unreadBefore, 1)

  const message = await getMessage('beta', created.id, 'inbox')
  assert.ok(message)
  assert.equal(message?.content.message.includes('Hello beta'), true)

  await markMessageAsRead('beta', created.id)
  const afterRead = await getMessage('beta', created.id, 'inbox')
  assert.equal(afterRead?.status, 'read')

  await archiveMessage('beta', created.id)
  const archived = await getMessage('beta', created.id, 'inbox')
  assert.equal(archived?.status, 'archived')

  await deleteMessage('beta', created.id)
  const removed = await getMessage('beta', created.id, 'inbox')
  assert.equal(removed, null)
})

test('forwarding preserves metadata and validation guards', async () => {
  const { messageQueue } = await setupPromise
  const {
    sendMessage,
    forwardMessage,
    listInboxMessages,
    getMessage,
    resetMessageStoreForTests,
  } = messageQueue

  await resetMessageStoreForTests()
  const original = await sendMessage('ops', 'dev', 'Deployment ready', {
    type: 'update',
    message: 'Release candidate passed QA.',
  })

  const forwarded = await forwardMessage(original.id, 'dev', 'support', 'FYI see below')
  assert.equal(forwarded.forwardedFrom?.originalMessageId, original.id)
  assert.equal(forwarded.to, 'support')

  const supportInbox = await listInboxMessages('support')
  assert.equal(supportInbox.length, 1)
  const forwardedMsg = await getMessage('support', forwarded.id, 'inbox')
  assert.equal(forwardedMsg?.forwardedFrom?.forwardedBy, 'dev')
})

test('invalid session names are rejected', async () => {
  const { messageQueue } = await setupPromise
  const { sendMessage, resetMessageStoreForTests } = messageQueue

  await resetMessageStoreForTests()
  await assert.rejects(
    () =>
      sendMessage('bad name', 'valid', 'Oops', {
        type: 'notification',
        message: 'This should fail',
      }),
    /Invalid from session name/
  )
})

test('message previews trim text', async () => {
  const { messageQueue } = await setupPromise
  const { sendMessage, listInboxMessages, resetMessageStoreForTests } = messageQueue

  await resetMessageStoreForTests()
  await sendMessage('alpha', 'beta', 'Preview', {
    type: 'notification',
    message: '   Lots of spacing should be trimmed down to a friendly preview string that is readable.   ',
  })
  const inbox = await listInboxMessages('beta')
  assert.equal(inbox[0].preview.startsWith('Lots of spacing'), true)
})
