import { defineStore } from 'pinia'
import type { ProjectRecord } from '~/types/agent'
import { runtimeRequest } from '~/utils/runtimeClient'
import { useSessionStore } from '~/stores/sessionStore'

const storageKey = 'aurora:workspaces:v1'
interface WorkspaceResult { name: string; path: string; isGitRepository: boolean; writable: boolean }

export const useProjectStore = defineStore('projects', {
  state: () => ({
    projects: [] as ProjectRecord[], activeProjectId: null as string | null,
    loaded: false, loading: false,
  }),
  getters: {
    activeProject: (state) => state.projects.find((item) => item.id === state.activeProjectId),
    byId: (state) => (id: string) => state.projects.find((item) => item.id === id),
  },
  actions: {
    setActive(id: string | null) { this.activeProjectId = id; this.persist() },
    persist() {
      if (import.meta.client) localStorage.setItem(storageKey, JSON.stringify({ projects: this.projects, activeProjectId: this.activeProjectId }))
    },
    async loadAll() {
      if (this.loaded || !import.meta.client) return
      this.loading = true
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || '{}')
        this.projects = Array.isArray(saved.projects) ? saved.projects : []
        this.activeProjectId = typeof saved.activeProjectId === 'string' ? saved.activeProjectId : this.projects[0]?.id ?? null
        this.loaded = true
      } finally { this.loading = false }
    },
    async get(id: string) {
      const project = this.byId(id)
      if (!project) throw new Error('工作区不存在')
      await runtimeRequest('workspace.validate', { path: project.path })
      return project
    },
    async create(path: string) {
      const workspace = await runtimeRequest<WorkspaceResult>('workspace.validate', { path })
      const existing = this.projects.find((item) => item.path === workspace.path)
      if (existing) { this.activeProjectId = existing.id; this.persist(); return existing }
      const now = new Date().toISOString()
      const project: ProjectRecord = {
        id: `workspace_${crypto.randomUUID()}`, name: String(workspace.name), path: String(workspace.path),
        isGitRepository: Boolean(workspace.isGitRepository), writable: Boolean(workspace.writable),
        createdAt: now, updatedAt: now,
      }
      this.projects.push(project)
      this.activeProjectId = project.id
      this.persist()
      return project
    },
    async rename(id: string, name: string) {
      const project = this.byId(id)
      if (!project) throw new Error('工作区不存在')
      project.name = name; project.updatedAt = new Date().toISOString(); this.persist()
      return project
    },
    async delete(id: string) {
      const sessionStore = useSessionStore()
      await Promise.all(sessionStore.sessions.filter((item) => item.projectId === id).map((item) => sessionStore.delete(item.id)))
      this.projects = this.projects.filter((item) => item.id !== id)
      if (this.activeProjectId === id) this.activeProjectId = this.projects[0]?.id ?? null
      this.persist()
    },
    remove(id: string) { this.projects = this.projects.filter((item) => item.id !== id); this.persist() },
  },
})
