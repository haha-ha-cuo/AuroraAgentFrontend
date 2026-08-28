import { defineStore } from 'pinia'
import type { SessionRecord } from '~/types/agent'
import { normalizeSession } from '~/utils/normalizers'
import { runtimeRequest } from '~/utils/runtimeClient'
import { useProjectStore } from '~/stores/projectStore'

export const useSessionStore = defineStore('sessions', {
  state: () => ({ sessions: [] as SessionRecord[], activeSessionId: null as string | null, loaded: true, loading: false }),
  getters: {
    activeSession: (state) => state.sessions.find((item) => item.id === state.activeSessionId),
    sorted(state): SessionRecord[] { return [...state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) },
    isRunning: (state) => (sessionId: string) => state.sessions.some((item) => item.id === sessionId && ['running', 'waiting', 'queued'].includes(item.status)),
  },
  actions: {
    getSession(id: string) { return this.sessions.find((item) => item.id === id) },
    upsert(raw: unknown) {
      const session = normalizeSession(raw as Record<string, unknown>)
      const index = this.sessions.findIndex((item) => item.id === session.id)
      if (index >= 0) this.sessions[index] = session
      else this.sessions.push(session)
      return session
    },
    setActive(id: string | null) { this.activeSessionId = id },
    remove(id: string) { this.sessions = this.sessions.filter((item) => item.id !== id); if (this.activeSessionId === id) this.activeSessionId = null },
    removeByProject(projectId: string) { this.sessions = this.sessions.filter((item) => item.projectId !== projectId) },
    async loadAll() {},
    async load(id: string) {
      const session = this.getSession(id)
      if (!session) throw new Error('会话不存在；后端重启后请新建会话')
      return session
    },
    async create(title = '新对话', projectId?: string | null) {
      const projects = useProjectStore()
      const targetId = projectId || projects.activeProjectId || projects.projects[0]?.id
      const project = targetId ? projects.byId(targetId) : undefined
      if (!project) throw new Error('请先添加一个工作区')
      const result = await runtimeRequest<any>('session.create', {
        workspacePath: project.path, sandboxMode: 'workspace-write', approvalMode: 'interactive',
      })
      const now = new Date().toISOString()
      const session: SessionRecord = {
        id: String(result.sessionId), title, projectId: project.id, createdAt: now, updatedAt: now,
        status: 'idle', messages: [], runs: [], tasks: [], approvals: [],
      }
      this.sessions.push(session); this.activeSessionId = session.id
      return session
    },
    async rename(id: string, title: string) {
      const session = this.getSession(id)
      if (!session) throw new Error('会话不存在')
      session.title = title; session.updatedAt = new Date().toISOString()
      return session
    },
    async delete(id: string) { await runtimeRequest('session.close', { sessionId: id }).catch(() => {}); this.remove(id) },
    async clearAll() {
      await Promise.all(this.sessions.map((item) => runtimeRequest('session.close', { sessionId: item.id }).catch(() => {})))
      this.sessions = []; this.activeSessionId = null
    },
  },
})
