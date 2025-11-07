import client from 'prom-client'

const register = new client.Registry()

client.collectDefaultMetrics({ register })

const connectedClientsGauge = new client.Gauge({
  name: 'maestro_gateway_connected_clients',
  help: 'Number of active WebSocket clients per session',
  labelNames: ['session']
})

const bytesOutCounter = new client.Counter({
  name: 'maestro_gateway_bytes_out_total',
  help: 'Bytes streamed from PTY to clients (live data)',
  labelNames: ['session']
})

const replayBytesCounter = new client.Counter({
  name: 'maestro_gateway_replay_bytes_total',
  help: 'Bytes replayed from history on client join',
  labelNames: ['session']
})

const ptyPauseCounter = new client.Counter({
  name: 'maestro_gateway_pty_pause_total',
  help: 'Number of times the PTY was paused due to backpressure',
  labelNames: ['session']
})

const ptyResumeCounter = new client.Counter({
  name: 'maestro_gateway_pty_resume_total',
  help: 'Number of times the PTY was resumed after backpressure',
  labelNames: ['session']
})

const ackBytesCounter = new client.Counter({
  name: 'maestro_gateway_acknowledged_bytes_total',
  help: 'Bytes acknowledged by clients',
  labelNames: ['session']
})

const activeReplayGauge = new client.Gauge({
  name: 'maestro_gateway_active_replays',
  help: 'Number of in-flight history replays'
})

const replayQueueGauge = new client.Gauge({
  name: 'maestro_gateway_replay_queue_length',
  help: 'Number of clients waiting for history replay'
})

const activeSessionsGauge = new client.Gauge({
  name: 'maestro_gateway_active_sessions',
  help: 'Number of active dtach sessions managed by the gateway'
})

const sessionPausedGauge = new client.Gauge({
  name: 'maestro_gateway_session_paused',
  help: 'Whether a session is currently paused due to backpressure (1=yes)',
  labelNames: ['session']
})

const sessionLastActivityGauge = new client.Gauge({
  name: 'maestro_gateway_session_last_activity_timestamp',
  help: 'Last PTY activity timestamp per session (unix seconds)',
  labelNames: ['session']
})

register.registerMetric(connectedClientsGauge)
register.registerMetric(bytesOutCounter)
register.registerMetric(replayBytesCounter)
register.registerMetric(ptyPauseCounter)
register.registerMetric(ptyResumeCounter)
register.registerMetric(ackBytesCounter)
register.registerMetric(activeReplayGauge)
register.registerMetric(replayQueueGauge)
register.registerMetric(activeSessionsGauge)
register.registerMetric(sessionPausedGauge)
register.registerMetric(sessionLastActivityGauge)

export const metrics = {
  clientJoined(session: string) {
    connectedClientsGauge.inc({ session })
  },
  clientLeft(session: string) {
    connectedClientsGauge.dec({ session })
  },
  resetSession(session: string) {
    try {
      connectedClientsGauge.remove({ session })
      sessionPausedGauge.remove({ session })
      sessionLastActivityGauge.remove({ session })
    } catch {}
  },
  recordBytesOut(session: string, bytes: number) {
    if (bytes > 0) {
      bytesOutCounter.inc({ session }, bytes)
    }
  },
  recordReplayBytes(session: string, bytes: number) {
    if (bytes > 0) {
      replayBytesCounter.inc({ session }, bytes)
    }
  },
  recordPtyPause(session: string) {
    ptyPauseCounter.inc({ session })
  },
  recordPtyResume(session: string) {
    ptyResumeCounter.inc({ session })
  },
  recordAckBytes(session: string, bytes: number) {
    if (bytes > 0) {
      ackBytesCounter.inc({ session }, bytes)
    }
  },
  setActiveReplayCount(count: number) {
    activeReplayGauge.set(count)
  },
  setReplayQueueLength(length: number) {
    replayQueueGauge.set(length)
  },
  sessionOpened(session: string, lastActivity: number) {
    activeSessionsGauge.inc()
    sessionPausedGauge.labels(session).set(0)
    sessionLastActivityGauge.labels(session).set(lastActivity / 1000)
  },
  sessionClosed(session: string) {
    activeSessionsGauge.dec()
    metrics.resetSession(session)
  },
  setSessionPaused(session: string, paused: boolean) {
    sessionPausedGauge.labels(session).set(paused ? 1 : 0)
  },
  setSessionLastActivity(session: string, timestampMs: number) {
    sessionLastActivityGauge.labels(session).set(timestampMs / 1000)
  },
  async render(): Promise<string> {
    return register.metrics()
  }
}

export type Metrics = typeof metrics
