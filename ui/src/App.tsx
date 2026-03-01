import { useState, useEffect, useCallback } from 'react'
import './App.css'

// --- Types ---

interface KnowledgeEntry {
  project: string
  key: string
  content: string
  category: string
  source_node: { id: string; summary: string; resolved: boolean } | null
  created_by: string
  created_at: string
  updated_at: string
  days_stale: number
}

interface LogEntry {
  action: string
  old_content: string | null
  new_content: string | null
  agent: string
  timestamp: string
}

// --- Helpers ---

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

const CATEGORY_COLORS: Record<string, string> = {
  architecture: 'var(--color-blue)',
  convention: 'var(--color-purple)',
  decision: 'var(--color-orange)',
  'api-contract': 'var(--color-green)',
  discovery: 'var(--color-yellow)',
  environment: 'var(--color-text-tertiary)',
  general: 'var(--color-text-secondary)',
}

function categoryColor(cat: string): string {
  return CATEGORY_COLORS[cat] ?? 'var(--color-text-secondary)'
}

// Unique key across projects (entries in different projects can share keys)
function entryId(e: KnowledgeEntry): string {
  return `${e.project}::${e.key}`
}

// --- Components ---

function CategoryBadge({ category }: { category: string }) {
  const color = categoryColor(category)
  return (
    <span className="category-badge" style={{ color, borderColor: color }}>
      {category}
    </span>
  )
}

function ProjectBadge({ project }: { project: string }) {
  return <span className="project-badge">{project}</span>
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() =>
    localStorage.getItem('graph-theme') ?? 'dark'
  )
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('graph-theme', theme)
  }, [theme])
  return (
    <button
      className="theme-toggle"
      onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      {theme === 'dark' ? '◑' : '◐'}
    </button>
  )
}

function EntryList({
  entries,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  categoryFilter,
  onCategoryFilter,
  projectFilter,
  onProjectFilter,
}: {
  entries: KnowledgeEntry[]
  selectedId: string | null
  onSelect: (entry: KnowledgeEntry) => void
  search: string
  onSearchChange: (s: string) => void
  categoryFilter: string | null
  onCategoryFilter: (cat: string | null) => void
  projectFilter: string | null
  onProjectFilter: (proj: string | null) => void
}) {
  const categories = [...new Set(entries.map(e => e.category))].sort()
  const projects = [...new Set(entries.map(e => e.project))].sort()

  // Filter
  const filtered = entries.filter(e => {
    if (categoryFilter && e.category !== categoryFilter) return false
    if (projectFilter && e.project !== projectFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return e.key.toLowerCase().includes(q) || e.content.toLowerCase().includes(q)
    }
    return true
  })

  return (
    <div className="entry-list">
      <div className="search-bar">
        <input
          type="text"
          placeholder="Search knowledge..."
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          className="search-input"
        />
      </div>
      <div className="filter-section">
        {projects.length > 1 && (
          <div className="filter-row">
            <button
              className={`filter-pill ${projectFilter === null ? 'active' : ''}`}
              onClick={() => onProjectFilter(null)}
            >
              all projects
            </button>
            {projects.map(proj => (
              <button
                key={proj}
                className={`filter-pill ${projectFilter === proj ? 'active' : ''}`}
                onClick={() => onProjectFilter(projectFilter === proj ? null : proj)}
              >
                {proj}
              </button>
            ))}
          </div>
        )}
        <div className="filter-row">
          <button
            className={`filter-pill ${categoryFilter === null ? 'active' : ''}`}
            onClick={() => onCategoryFilter(null)}
          >
            all ({filtered.length})
          </button>
          {categories.map(cat => {
            const count = filtered.filter(e => e.category === cat).length
            if (count === 0) return null
            return (
              <button
                key={cat}
                className={`filter-pill ${categoryFilter === cat ? 'active' : ''}`}
                onClick={() => onCategoryFilter(categoryFilter === cat ? null : cat)}
                style={categoryFilter === cat ? { color: categoryColor(cat), borderColor: categoryColor(cat) } : {}}
              >
                {cat} ({count})
              </button>
            )
          })}
        </div>
      </div>
      <div className="entry-items">
        {filtered.map(entry => (
          <button
            key={entryId(entry)}
            className={`entry-item ${selectedId === entryId(entry) ? 'selected' : ''}`}
            onClick={() => onSelect(entry)}
          >
            <div className="entry-item-header">
              <span className="entry-key">{entry.key}</span>
              <span className="entry-age">{timeAgo(entry.updated_at)}</span>
            </div>
            <div className="entry-item-meta">
              <CategoryBadge category={entry.category} />
              {projects.length > 1 && <ProjectBadge project={entry.project} />}
              <span className="entry-author">{entry.created_by}</span>
              {entry.days_stale > 7 && (
                <span className="stale-indicator">stale</span>
              )}
            </div>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="empty-state">
            {entries.length === 0 ? 'No knowledge entries yet.' : 'No entries match your filters.'}
          </div>
        )}
      </div>
    </div>
  )
}

function EntryDetail({
  entry,
  log,
  logLoading,
  showProject,
}: {
  entry: KnowledgeEntry
  log: LogEntry[]
  logLoading: boolean
  showProject: boolean
}) {
  const [showHistory, setShowHistory] = useState(false)

  return (
    <div className="entry-detail">
      <div className="detail-header">
        <h2 className="detail-key">{entry.key}</h2>
        <div className="detail-meta">
          <CategoryBadge category={entry.category} />
          {showProject && (
            <>
              <span className="meta-sep">·</span>
              <ProjectBadge project={entry.project} />
            </>
          )}
          <span className="meta-sep">·</span>
          <span className="meta-text">{entry.created_by}</span>
          <span className="meta-sep">·</span>
          <span className="meta-text">{timeAgo(entry.updated_at)}</span>
          {entry.days_stale > 7 && (
            <>
              <span className="meta-sep">·</span>
              <span className="stale-indicator">{entry.days_stale}d stale</span>
            </>
          )}
        </div>
        {entry.source_node && (
          <div className="source-node">
            <span className="source-label">source:</span>
            <span className={`source-summary ${entry.source_node.resolved ? 'resolved' : ''}`}>
              {entry.source_node.summary}
            </span>
          </div>
        )}
      </div>

      <div className="detail-content">
        <pre className="content-text">{entry.content}</pre>
      </div>

      <div className="detail-history">
        <button
          className="history-toggle"
          onClick={() => setShowHistory(!showHistory)}
        >
          {showHistory ? '▾' : '▸'} History {!logLoading && `(${log.length})`}
        </button>
        {showHistory && (
          <div className="history-list">
            {logLoading ? (
              <div className="history-loading">Loading...</div>
            ) : log.length === 0 ? (
              <div className="history-empty">No history recorded.</div>
            ) : (
              log.map((entry, i) => (
                <div key={i} className="history-item">
                  <span className="history-action">{entry.action}</span>
                  <span className="history-agent">{entry.agent}</span>
                  <span className="history-time">{timeAgo(entry.timestamp)}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// --- App ---

export default function App() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [logLoading, setLogLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dbPath, setDbPath] = useState<string | null>(null)

  // Track change detection
  const [changeFingerprint, setChangeFingerprint] = useState('')

  // Load all knowledge + health info
  useEffect(() => {
    Promise.all([
      fetch('/api/knowledge').then(r => r.json()),
      fetch('/api/health').then(r => r.json()),
    ])
      .then(([knowledgeData, healthData]: [KnowledgeEntry[], { db_path?: string }]) => {
        setEntries(knowledgeData)
        if (healthData.db_path) setDbPath(healthData.db_path)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  // Reload all knowledge
  const loadKnowledge = useCallback(() => {
    fetch('/api/knowledge')
      .then(r => r.json())
      .then((data: KnowledgeEntry[]) => {
        setEntries(data)
        // If selected entry no longer exists, deselect
        if (selectedId && !data.some(e => entryId(e) === selectedId)) {
          setSelectedId(null)
        }
      })
      .catch(() => {})
  }, [selectedId])

  // Load log when selected entry changes
  const selectedEntry = entries.find(e => entryId(e) === selectedId) ?? null

  useEffect(() => {
    if (!selectedEntry) {
      setLog([])
      return
    }
    setLogLoading(true)
    fetch(`/api/projects/${encodeURIComponent(selectedEntry.project)}/knowledge/${encodeURIComponent(selectedEntry.key)}/log`)
      .then(r => r.json())
      .then((data: LogEntry[]) => {
        setLog(data)
        setLogLoading(false)
      })
      .catch(() => setLogLoading(false))
  }, [selectedId])

  // Polling for changes
  useEffect(() => {
    let active = true
    let timeout: ReturnType<typeof setTimeout>

    const poll = () => {
      if (document.hidden) {
        timeout = setTimeout(poll, 2000)
        return
      }
      fetch('/api/changes')
        .then(r => r.json())
        .then(data => {
          if (!active) return
          const fp = `${data.latest}:${data.count}:${data.knowledge_count ?? 0}`
          if (changeFingerprint && fp !== changeFingerprint) {
            loadKnowledge()
          }
          setChangeFingerprint(fp)
          timeout = setTimeout(poll, 2000)
        })
        .catch(() => {
          if (active) timeout = setTimeout(poll, 5000)
        })
    }

    poll()
    return () => { active = false; clearTimeout(timeout) }
  }, [changeFingerprint, loadKnowledge])

  const projects = [...new Set(entries.map(e => e.project))]

  if (loading) {
    return <div className="app-loading">Loading...</div>
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="header-title">Knowledge</h1>
          <span className="entry-count">{entries.length} entries</span>
          {dbPath && (
            <span className="db-path" title={dbPath}>
              {dbPath.split('/').pop()}
            </span>
          )}
        </div>
        <div className="header-right">
          <ThemeToggle />
        </div>
      </header>

      <main className="app-main">
        {entries.length === 0 && !loading ? (
          <div className="empty-project">
            <p>No knowledge entries yet.</p>
            <p className="empty-hint">Knowledge entries are created by agents via graph_knowledge_write.</p>
          </div>
        ) : (
          <>
            <EntryList
              entries={entries}
              selectedId={selectedId}
              onSelect={(entry) => setSelectedId(entryId(entry))}
              search={search}
              onSearchChange={setSearch}
              categoryFilter={categoryFilter}
              onCategoryFilter={setCategoryFilter}
              projectFilter={projectFilter}
              onProjectFilter={setProjectFilter}
            />
            <div className="detail-panel">
              {selectedEntry ? (
                <EntryDetail
                  entry={selectedEntry}
                  log={log}
                  logLoading={logLoading}
                  showProject={projects.length > 1}
                />
              ) : (
                <div className="no-selection">
                  Select an entry to view its content.
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
