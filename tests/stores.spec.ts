import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useProjectStore } from '~/stores/projectStore'
import { useGitStore } from '~/stores/gitStore'
import { useSessionStore } from '~/stores/sessionStore'
import { useUiStore } from '~/stores/uiStore'
import { runtimeRequest } from '~/utils/runtimeClient'

vi.mock('~/utils/runtimeClient', () => ({ runtimeRequest: vi.fn() }))

describe('application stores', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    })
    vi.mocked(runtimeRequest).mockReset()
  })

  it('creates and reuses validated workspaces', async () => {
    vi.mocked(runtimeRequest).mockResolvedValue({
      name: 'workspace', path: '/tmp/workspace', isGitRepository: true, writable: true,
    })
    const projects = useProjectStore()
    const first = await projects.create('/tmp/workspace')
    const second = await projects.create('/tmp/workspace')
    expect(first.id).toBe(second.id)
    expect(projects.projects).toHaveLength(1)
    expect(projects.activeProjectId).toBe(first.id)
  })

  it('automatically initializes a non-Git workspace', async () => {
    vi.mocked(runtimeRequest)
      .mockResolvedValueOnce({ name: 'workspace', path: '/tmp/workspace', isGitRepository: false, writable: true })
      .mockResolvedValueOnce({ name: 'workspace', path: '/tmp/workspace', isGitRepository: true, writable: true })
    const project = await useProjectStore().create('/tmp/workspace')
    expect(project.isGitRepository).toBe(true)
    expect(runtimeRequest).toHaveBeenNthCalledWith(2, 'workspace.git.initialize', { path: '/tmp/workspace' })
  })

  it('loads Git status and rolls back a run', async () => {
    const status = {
      view: 'run', runId: 'r1', branch: 'main', head: 'abc', unborn: false,
      files: [{ path: 'a.ts', status: 'M', staged: false, unstaged: true, untracked: false, binary: false, additions: 1, deletions: 1 }],
      canRollback: true, rollbackReason: '',
    }
    vi.mocked(runtimeRequest).mockResolvedValueOnce(status).mockResolvedValueOnce({ reverted: true })
    const git = useGitStore()
    await git.loadStatus('s1', 'run', 'r1')
    expect(git.statusFor('s1', 'run', 'r1')?.files[0]?.path).toBe('a.ts')
    await git.rollback('s1', 'r1')
    expect(git.statusFor('s1', 'run', 'r1')).toBeUndefined()
  })

  it('creates and removes a session bound to the active project', async () => {
    const projects = useProjectStore()
    projects.projects.push({
      id: 'p1', name: 'workspace', path: '/tmp/workspace', isGitRepository: true,
      writable: true, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    })
    projects.activeProjectId = 'p1'
    vi.mocked(runtimeRequest).mockResolvedValue({ sessionId: 's1' })
    const sessions = useSessionStore()
    const session = await sessions.create('测试')
    expect(session.projectId).toBe('p1')
    await sessions.delete('s1')
    expect(sessions.sessions).toHaveLength(0)
  })

  it('updates UI preferences', () => {
    const ui = useUiStore()
    ui.setTheme('dark')
    ui.toggleSidebar()
    expect(ui.theme).toBe('dark')
    expect(ui.sidebarCollapsed).toBe(true)
  })
})
