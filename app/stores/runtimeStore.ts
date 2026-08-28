import { defineStore } from 'pinia'
import type { ApprovalRequest, AttachmentRef, McpConnection, McpPackage, RuntimeEvent, RuntimeInfo } from '~/types/agent'
import { normalizeTask } from '~/utils/normalizers'
import { connectRuntime, onRuntimeEvent, restartRuntimeBroker, runtimeRequest } from '~/utils/runtimeClient'
import { useSessionStore } from '~/stores/sessionStore'
import { useProjectStore } from '~/stores/projectStore'

let initialized: Promise<void> | null = null
let unsubscribe: (() => void) | null = null
const streamBuffers = new Map<string, { sessionId: string; pending: string; finalText?: string; timer?: ReturnType<typeof setTimeout> }>()

function flushStreamBuffer(messageId: string) {
  const buffer = streamBuffers.get(messageId)
  if (!buffer) return
  const message = useSessionStore().getSession(buffer.sessionId)?.messages.find((item) => item.id === messageId)
  if (!message) { streamBuffers.delete(messageId); return }
  const delta = buffer.pending.slice(0, 8)
  buffer.pending = buffer.pending.slice(delta.length)
  message.content += delta
  if (buffer.pending) {
    buffer.timer = setTimeout(() => flushStreamBuffer(messageId), 16)
  } else if (buffer.finalText !== undefined) {
    message.content = buffer.finalText
    message.status = 'completed'
    streamBuffers.delete(messageId)
  } else {
    buffer.timer = undefined
  }
}

function enqueueStreamDelta(sessionId: string, messageId: string, delta: string) {
  const buffer = streamBuffers.get(messageId) ?? { sessionId, pending: '' }
  buffer.pending += delta
  streamBuffers.set(messageId, buffer)
  if (!buffer.timer) flushStreamBuffer(messageId)
}

function completeStreamMessage(sessionId: string, messageId: string, content: string) {
  const buffer = streamBuffers.get(messageId) ?? { sessionId, pending: '' }
  buffer.finalText = content
  streamBuffers.set(messageId, buffer)
  if (!buffer.timer) flushStreamBuffer(messageId)
}

export const useRuntimeStore = defineStore('runtime', {
  state: () => ({
    connectionStatus: 'disconnected' as RuntimeInfo['status'],
    info: { status: 'disconnected', mode: 'stdio/websocket', version: '1', databasePath: '', activeRuns: 0, capabilities: [] } as RuntimeInfo,
    approvals: [] as ApprovalRequest[], lastError: '',
    packages: [] as McpPackage[], connections: [] as McpConnection[], serverConnections: [] as McpConnection[], pluginErrors: {} as Record<string, string>,
  }),
  getters: {
    approvalsFor: (state) => (sessionId: string) => state.approvals.filter((item) => item.sessionId === sessionId && item.status === 'pending'),
  },
  actions: {
    async initialize() {
      if (initialized) return initialized
      initialized = (async () => {
        this.connectionStatus = 'connecting'
        try {
          await connectRuntime()
          if (!unsubscribe) unsubscribe = onRuntimeEvent((event) => this.handleEvent(event))
          const result = await runtimeRequest<any>('runtime.initialize')
          this.info = { status: 'connected', mode: 'stdio/websocket', version: String(result.protocolVersion ?? '1'), databasePath: '', activeRuns: 0, capabilities: result.capabilities ?? [] }
          await useProjectStore().loadAll()
          this.connectionStatus = 'connected'
        } catch (error) {
          this.connectionStatus = 'disconnected'
          this.lastError = error instanceof Error ? error.message : String(error)
          throw error
        }
      })().finally(() => { initialized = null })
      return initialized
    },
    async refreshStatus() { await this.initialize() },
    async restart() {
      this.connectionStatus = 'restarting'
      await restartRuntimeBroker()
      useSessionStore().sessions = []
      this.approvals = []
      await this.initialize()
    },
    async startRun(sessionId: string, goal: string, attachments: AttachmentRef[] = []) {
      const sessions = useSessionStore()
      const session = sessions.getSession(sessionId)
      if (!session) throw new Error('会话不存在')
      const now = new Date().toISOString()
      session.messages.push({
        id: `message_${crypto.randomUUID()}`, sessionId, role: 'user', content: goal,
        createdAt: now, status: 'completed', kind: 'message', attachments,
      })
      session.status = 'running'; session.updatedAt = now; this.info.activeRuns += 1
      try {
        const update = await runtimeRequest<any>('run.start', { sessionId, goal })
        this.applyUpdate(update)
        return update
      } catch (error) {
        session.status = 'failed'
        session.messages.push({
          id: `message_${crypto.randomUUID()}`, sessionId, role: 'assistant', content: error instanceof Error ? error.message : String(error),
          createdAt: new Date().toISOString(), status: 'failed', kind: 'error', attachments: [],
        })
        throw error
      } finally { this.info.activeRuns = Math.max(0, this.info.activeRuns - 1) }
    },
    async resumeInput(id: string, response: unknown) {
      const request = this.approvals.find((item) => item.id === id)
      if (!request) throw new Error('待处理请求不存在')
      const update = await runtimeRequest<any>('run.resume', {
        sessionId: request.sessionId, runId: request.runId,
        interruptId: request.interruptId || request.id, response,
      })
      request.status = response === false || (typeof response === 'object' && response && (response as any).approved === false) ? 'rejected' : 'approved'
      this.applyUpdate(update)
    },
    async resolveApproval(id: string, approved: boolean) { await this.resumeInput(id, { approved }) },
    applyUpdate(update: any) {
      const sessions = useSessionStore()
      const session = sessions.getSession(String(update.sessionId ?? ''))
      if (!session) return
      const now = new Date().toISOString()
      const runId = String(update.runId ?? '')
      const userMessage = [...session.messages].reverse().find((item) => item.role === 'user' && !item.runId)
      if (userMessage) userMessage.runId = runId
      const run = session.runs.find((item) => item.id === runId)
      const goal = String(update.state?.goal ?? run?.objective ?? '')
      if (run) { run.status = update.status; run.updatedAt = now }
      else session.runs.push({ id: runId, sessionId: session.id, objective: goal, status: update.status, error: '', createdAt: now, updatedAt: now })
      const results = new Map((update.state?.results ?? []).map((item: any) => [String(item.task_id), item]))
      for (const raw of update.state?.tasks ?? []) {
        const result: any = results.get(String(raw.id))
        const task = session.tasks.find((item) => item.id === String(raw.id))
        const next = {
          id: String(raw.id), sessionId: session.id, runId, parentId: null,
          description: String(raw.description ?? '未命名任务'), tool: String(raw.tool ?? ''), effort: raw.effort ?? 'medium',
          status: result ? (result.ok ? 'completed' : 'failed') : update.status === 'waiting' ? 'waiting' : 'queued',
          output: String(result?.output ?? ''), error: result?.ok === false ? String(result.output ?? '') : '',
          createdAt: task?.createdAt ?? now, updatedAt: now,
        } as const
        if (task) Object.assign(task, next); else session.tasks.push(next)
      }
      session.status = update.status
      session.updatedAt = now
      if (update.status === 'completed' && update.state?.report && !session.messages.some((item) => item.runId === runId && item.role === 'assistant')) {
        session.messages.push({
          id: `message_${crypto.randomUUID()}`, sessionId: session.id, runId, role: 'assistant', content: String(update.state.report),
          createdAt: now, status: 'completed', kind: 'report', attachments: [],
        })
      }
      for (const pending of update.interruptions ?? []) this.addInterruption(session.id, runId, pending)
    },
    addInterruption(sessionId: string, runId: string, pending: any) {
      const id = String(pending.interruptId ?? '')
      if (!id || this.approvals.some((item) => item.id === id)) return
      const kind = pending.kind === 'clarification' || pending.kind === 'evaluation' ? pending.kind : 'approval'
      this.approvals.push({
        id, interruptId: id, sessionId, runId, kind,
        action: String(pending.action ?? pending.question ?? (kind === 'approval' ? '执行受保护操作' : '需要你的输入')),
        question: String(pending.question ?? ''), risk: String(pending.risk ?? kind),
        details: String(pending.details ?? ''), status: 'pending',
      })
    },
    async handleEvent(event: RuntimeEvent) {
      if (event.type === 'runtime.disconnected') { this.connectionStatus = 'disconnected'; this.lastError = '运行时已断开'; return }
      const payload: any = event.payload ?? {}
      const sessionId = String(event.session_id ?? payload.sessionId ?? payload.session_id ?? '')
      const runId = String(event.run_id ?? payload.runId ?? payload.run_id ?? '')
      const session = useSessionStore().getSession(sessionId)
      if (session && event.type === 'run.started') {
        const now = event.occurred_at || new Date().toISOString()
        const userMessage = [...session.messages].reverse().find((item) => item.role === 'user' && !item.runId)
        if (userMessage) userMessage.runId = runId
        if (!session.runs.some((item) => item.id === runId)) {
          session.runs.push({ id: runId, sessionId, objective: String(payload.goal ?? ''), status: 'running', error: '', createdAt: now, updatedAt: now })
        }
        session.status = 'running'
      }
      if (event.type === 'run.completed') this.applyUpdate(payload)
      if (['approval.required', 'clarification.required', 'evaluation.required', 'run.input_required'].includes(event.type)) {
        this.addInterruption(sessionId, runId, payload)
      }
      if (session && event.type === 'plan.created') {
        for (const raw of payload.tasks ?? []) {
          const task = normalizeTask(raw, sessionId, runId)
          const index = session.tasks.findIndex((item) => item.id === task.id)
          if (index >= 0) session.tasks[index] = task; else session.tasks.push(task)
        }
      }
      if (session && event.type.startsWith('task.')) {
        const taskId = String(event.task_id ?? payload.taskId ?? payload.task_id ?? payload.id ?? '')
        const task = session.tasks.find((item) => item.id === taskId)
        if (task && event.type === 'task.started') task.status = 'running'
        if (task && event.type === 'task.completed') { task.status = 'completed'; task.output = String(payload.output ?? '') }
        if (task && event.type === 'task.failed') { task.status = 'failed'; task.error = String(payload.error ?? '') }
      }
      if (session && event.type.startsWith('message.')) {
        const messageId = String(payload.messageId ?? payload.message_id ?? '')
        let message = session.messages.find((item) => item.id === messageId)
        if (!message) {
          message = {
            id: messageId || `message_${crypto.randomUUID()}`, sessionId, runId, role: 'assistant', content: '',
            createdAt: event.occurred_at || new Date().toISOString(), status: 'streaming', kind: 'report', attachments: [],
          }
          session.messages.push(message)
        }
        if (event.type === 'message.delta') enqueueStreamDelta(sessionId, message.id, String(payload.delta ?? ''))
        if (event.type === 'message.completed') completeStreamMessage(sessionId, message.id, String(payload.content ?? message.content))
      }
    },
    async loadMcp() {
      const [catalog, connected, servers] = await Promise.all([
        runtimeRequest<any>('mcp.package.catalog'), runtimeRequest<any>('mcp.package.list'), runtimeRequest<any>('mcp.server.list'),
      ])
      this.packages = catalog.packages ?? []; this.pluginErrors = catalog.pluginErrors ?? {}; this.connections = connected.packages ?? []; this.serverConnections = servers.servers ?? []
    },
    async connectPackage(packageId: string, instanceName: string, config: Record<string, unknown>) {
      await runtimeRequest('mcp.package.connect', { packageId, instanceName: instanceName || packageId, config })
      await this.loadMcp()
    },
    async disconnectPackage(instanceName: string) { await runtimeRequest('mcp.package.disconnect', { instanceName }); await this.loadMcp() },
    async connectServer(config: Record<string, unknown>) { await runtimeRequest('mcp.server.connect', config); await this.loadMcp() },
    async disconnectServer(name: string) { await runtimeRequest('mcp.server.disconnect', { name }); await this.loadMcp() },
  },
})
