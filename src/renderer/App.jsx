import { useState, useEffect, useRef, useCallback } from 'react'

// ── Web API helper ─────────────────────────────────────────────────────────────
// Replaces window.engram.* (Electron IPC) with fetch() calls to the Express
// server.  TOKEN is read from localStorage so each browser session can carry
// its own credential without a login page.

const TOKEN = localStorage.getItem('engram_token') || ''

async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      'Content-Type':   'application/json',
      'x-engram-token': TOKEN,
    },
  }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetch(path, opts)
  return res.json()
}

// ── Null-safe string coercion ──────────────────────────────────────────────────
// Use safeStr() anywhere a value from the database (doc.title, tag.description,
// etc.) needs to be used as a string.  Prevents "Cannot read properties of null
// (reading 'replace')" crashes when optional DB columns are NULL.

function safeStr(val) {
  if (val === null || val === undefined) return ''
  return String(val)
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const BG       = '#020810'
const PANEL    = '#030e1a'
const PANEL2   = '#041220'
const BORDER   = '#081828'
const BORDER2  = '#0d2035'
const ACCENT   = '#38bdf8'
const ACCENTD  = '#0c3554'
const TEXT     = '#e2e8f0'
const TEXTM    = '#64748b'
const TEXTD    = '#1e3a5f'
const ERR      = '#ef4444'
const WARN     = '#f59e0b'
const OK       = '#22c55e'
const MONO     = '"IBM Plex Mono", monospace'
const SANS     = '"IBM Plex Sans", sans-serif'

// ── Utilities ─────────────────────────────────────────────────────────────────

const coverageColor = pct => pct >= 80 ? OK : pct >= 60 ? WARN : ERR

const severityColor = s => ({ error: ERR, critical: '#dc2626', warning: WARN, info: ACCENT }[s?.toLowerCase()] ?? ACCENT)

function docTypeColor(t = '') {
  const s = t.toLowerCase()
  if (s.includes('dcs') || s.includes('config'))    return '#22c55e'
  if (s.includes('datasheet') || s.includes('spec')) return '#f97316'
  if (s.includes('loop') || s.includes('diagram'))  return '#3b82f6'
  if (s.includes('calibrat'))                        return '#8b5cf6'
  if (s.includes('hook') || s.includes('wiring'))   return '#ec4899'
  if (s.includes('procedure') || s.includes('work'))return '#14b8a6'
  return TEXTM
}

function parseIssueDesc(raw) {
  try { return JSON.parse(raw) } catch { return { title: raw, detail: '' } }
}

// Parse [DIFF]...[/DIFF] block from assistant text
function parseDiff(text = '') {
  const m = /\[DIFF\]([\s\S]*?)\[\/DIFF\]/i.exec(text)
  if (!m) return { body: text, diff: null }
  const d   = m[1]
  const field  = /Field:\s*(.+)/i.exec(d)?.[1]?.trim()
  const oldVal = /Old[^:]*:\s*(.+)/i.exec(d)?.[1]?.trim()
  const newVal = /New[^:]*:\s*(.+)/i.exec(d)?.[1]?.trim()
  return {
    body: text.replace(/\[DIFF\][\s\S]*?\[\/DIFF\]/i, '').trim(),
    diff: field ? { field, oldVal, newVal } : null,
  }
}

// Parse [SOURCE: ...] citation tags
function parseSources(text = '') {
  const re    = /\[SOURCE:\s*([^\]]+)\]/gi
  const srcs  = []
  let m
  while ((m = re.exec(text)) !== null) {
    const [fn, dt, rv] = m[1].split('|').map(s => s.trim())
    srcs.push({ fn, dt, rv })
  }
  return { body: text.replace(/\[SOURCE:[^\]]*\]/gi, '').trim(), srcs }
}

function relativeTime(isoStr) {
  if (!isoStr) return 'unknown'
  try {
    const diff = Date.now() - new Date(isoStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  } catch { return 'unknown' }
}

function fileTypeBadgeColor(ext = '') {
  const e = ext.toLowerCase()
  if (e === 'xlsx' || e === 'xls') return '#22c55e'
  if (e === 'pdf') return '#ef4444'
  if (e === 'docx' || e === 'doc') return '#3b82f6'
  return TEXTM
}

function highlightText(text = '', query = '') {
  if (!query.trim() || !text) return text
  const q   = query.trim().toLowerCase()
  const idx = text.toLowerCase().indexOf(q)
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: '#38bdf840', color: '#38bdf8', borderRadius: 2, padding: '0 1px' }}>
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  )
}

function getFileGroup(filename = '') {
  if (!filename) return 'Other'
  const ext = filename.split('.').pop().toLowerCase().trim()
  if (['xlsx', 'xls', 'xlsm', 'xlsb', 'csv'].includes(ext)) return 'Excel Files'
  if (['pdf'].includes(ext))                                  return 'PDF Files'
  if (['doc', 'docx', 'rtf'].includes(ext))                  return 'Word Documents'
  return 'Other'
}

function getGroupColor(groupName = '') {
  if (groupName.includes('Excel')) return '#22c55e'
  if (groupName.includes('PDF'))   return '#ef4444'
  if (groupName.includes('Word'))  return '#3b82f6'
  return '#64748b'
}

// Group tags by instrument-type prefix (e.g. FT, PT, LT)
function groupTags(tags = []) {
  const groups = {}
  for (const t of tags) {
    const key = (t.name?.split('-')[0] ?? 'OTHER').toUpperCase()
    ;(groups[key] = groups[key] ?? []).push(t)
  }
  return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
}

// ── Keyframe injection ────────────────────────────────────────────────────────
const STYLE_TAG = `
  @keyframes engram-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%       { opacity: .4; transform: scale(.7); }
  }
  @keyframes engram-spin {
    to { transform: rotate(360deg); }
  }
  @keyframes engram-fadein {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
`

// ── Atoms ─────────────────────────────────────────────────────────────────────

function PulsingDot({ color = ERR, size = 6 }) {
  return (
    <span style={{
      display: 'inline-block', flexShrink: 0,
      width: size, height: size, borderRadius: '50%',
      background: color,
      animation: 'engram-pulse 1.4s ease-in-out infinite',
    }} />
  )
}

function Badge({ children, bg, color, mono = true }) {
  return (
    <span style={{
      background: bg, color,
      fontSize: 9, fontFamily: mono ? MONO : SANS, fontWeight: 700,
      padding: '2px 6px', borderRadius: 3, letterSpacing: .5,
      whiteSpace: 'nowrap', flexShrink: 0,
    }}>
      {children}
    </span>
  )
}

function Divider({ vertical }) {
  return <div style={vertical
    ? { width: 1, background: BORDER, alignSelf: 'stretch', flexShrink: 0 }
    : { height: 1, background: BORDER, margin: '8px 0' }
  } />
}

function Spinner() {
  return (
    <span style={{
      display: 'inline-block', width: 12, height: 12,
      border: `2px solid ${ACCENTD}`, borderTopColor: ACCENT,
      borderRadius: '50%', animation: 'engram-spin .7s linear infinite',
    }} />
  )
}

// ── CoverageBar ───────────────────────────────────────────────────────────────

function CoverageBar({ pct = 0 }) {
  const color = coverageColor(pct)
  return (
    <div style={{ height: 2, background: BORDER2, borderRadius: 1, marginTop: 4, overflow: 'hidden' }}>
      <div style={{
        width: `${Math.min(100, pct)}%`, height: '100%',
        background: color, transition: 'width .4s',
      }} />
    </div>
  )
}

// ── TopBar ────────────────────────────────────────────────────────────────────
function TopBar({ engineerName, totalDocs, totalIssues, totalErrors, onEditConfig }) {
  const [savedMsg, setSavedMsg] = useState(false)
  const handleEditConfig = () => {
    if (onEditConfig) onEditConfig()
  }

  const handleSaveConfig = async () => {
    await api('POST', '/api/workspace/saveConfig').catch(console.error)
    setSavedMsg(true)
    setTimeout(() => setSavedMsg(false), 2000)
  }

  return (
    <div style={{
      height: 48, flexShrink: 0,
      background: PANEL, borderBottom: `1px solid ${BORDER}`,
      display: 'flex', alignItems: 'center',
      padding: '0 20px', gap: 16, zIndex: 10,
    }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginRight: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: 16, fontWeight: 700, color: ACCENT, letterSpacing: 3 }}>
          ENGRAM
        </span>
        <span style={{ fontFamily: MONO, fontSize: 8, color: TEXTD, letterSpacing: 2 }}>
          INTEGRITY
        </span>
      </div>

      <Divider vertical />

      {/* Status pills */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <StatPill label="DOCS"   value={totalDocs}   color={ACCENT} />
        <StatPill label="ISSUES" value={totalIssues} color={WARN}   />
        <StatPill label="ERRORS" value={totalErrors} color={totalErrors > 0 ? ERR : TEXTM} pulse={totalErrors > 0} />
      </div>

      <div style={{ flex: 1 }} />

      {/* Config buttons */}
      <button
        onClick={handleEditConfig}
        title="Open workspace.config.json in Notepad"
        style={{
          background: '#0d2035', color: '#64748b', border: '1px solid #081828',
          fontFamily: MONO, fontSize: 10, padding: '4px 8px',
          borderRadius: 3, cursor: 'pointer',
        }}
      >📝 Edit Config</button>
      <button
        onClick={handleSaveConfig}
        title="Save current settings to workspace.config.json"
        style={{
          background: '#0d2035', color: savedMsg ? '#34d399' : '#64748b', border: '1px solid #081828',
          fontFamily: MONO, fontSize: 10, padding: '4px 8px',
          borderRadius: 3, cursor: 'pointer', transition: 'color .2s',
        }}
      >{savedMsg ? '✓ Saved' : '💾 Save Config'}</button>

      {/* Engineer name */}
      {engineerName && (
        <span style={{ fontFamily: MONO, fontSize: 10, color: TEXTM }}>
          {engineerName}
        </span>
      )}
    </div>
  )
}

function StatPill({ label, value, color, pulse }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      background: PANEL2, border: `1px solid ${BORDER}`,
      borderRadius: 4, padding: '3px 8px',
    }}>
      {pulse && <PulsingDot color={color} size={5} />}
      <span style={{ fontFamily: MONO, fontSize: 10, color: TEXTM }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color }}>{value}</span>
    </div>
  )
}

// ── Left Panel — Tag Registry ─────────────────────────────────────────────────

function LeftPanel({ tags, activeTag, onSelectTag, onCreateTag, onUpdateTag, onDeleteTag, onCopyTag, onAddDocs, onReindex }) {
  const [searchText,    setSearchText]    = useState('')
  const [selectedTag,   setSelectedTag]   = useState(null)
  const [showAddForm,   setShowAddForm]   = useState(false)
  const [reindexing,    setReindexing]    = useState(false)
  const [cleanupMsg,    setCleanupMsg]    = useState(null)   // null | string
  const [hoverAdd,      setHoverAdd]      = useState(false)
  const [hoverReindex,  setHoverReindex]  = useState(false)
  const [hoverCleanup,  setHoverCleanup]  = useState(false)

  const handleReindexClick = () => {
    setReindexing(true)
    onReindex()
    setTimeout(() => setReindexing(false), 2000)
  }

  const handleCleanup = async () => {
    setCleanupMsg('Scanning…')
    try {
      const res = await api('POST', '/api/index/cleanup')
      if (res?.ok) {
        setCleanupMsg(res.cleaned > 0 ? `Cleaned ${res.cleaned} orphan${res.cleaned !== 1 ? 's' : ''}` : 'No orphans found')
      } else {
        setCleanupMsg('Cleanup failed')
      }
    } catch {
      setCleanupMsg('Cleanup failed')
    }
    setTimeout(() => setCleanupMsg(null), 3000)
  }

  const searchLower = searchText.toLowerCase()
  const filtered = !searchLower ? tags : tags.filter(t => {
    const id   = (t.tag_id || t.name || '').toLowerCase()
    const desc = (t.description || '').toLowerCase()
    const type = (t.instrument_type || '').toLowerCase()
    const area = (t.area || '').toLowerCase()
    return id.includes(searchLower) || desc.includes(searchLower) ||
           type.includes(searchLower) || area.includes(searchLower)
  })

  const groups = {}
  for (const tag of filtered) {
    const prefix = ((tag.tag_id || tag.name || '').split('-')[0] || 'OTHER').toUpperCase()
    if (!groups[prefix]) groups[prefix] = []
    groups[prefix].push(tag)
  }
  const groupKeys = Object.keys(groups).sort()

  const handleSelect = (tag) => {
    setSelectedTag(tag)
    onSelectTag(tag)
  }

  return (
    <div style={{
      width: 240, flexShrink: 0,
      background: '#030e1a', borderRight: '1px solid #081828',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #081828', background: '#041220', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
          <input
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            placeholder="Search tags…"
            style={{
              flex: 1, background: '#0d2035',
              border: `1px solid ${searchText ? '#38bdf860' : '#1e3a5f'}`,
              color: '#e2e8f0', fontFamily: MONO, fontSize: 10,
              padding: '3px 6px', borderRadius: 3, outline: 'none',
            }}
          />
          <button
            onClick={() => setShowAddForm(v => !v)}
            title="Add tag"
            style={{
              background: showAddForm ? '#1e3a5f' : '#1d4ed8', border: 'none',
              color: '#ffffff', fontFamily: MONO, fontSize: 13,
              padding: '1px 7px', borderRadius: 3, cursor: 'pointer', flexShrink: 0, lineHeight: 1.4,
            }}
          >+</button>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 9, color: '#64748b' }}>
          {filtered.length} tag{filtered.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Add tag form */}
      {showAddForm && (
        <AddTagForm
          onSave={data => { onCreateTag(data); setShowAddForm(false) }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* Tag list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 && (
          <div style={{ padding: '24px 12px', textAlign: 'center', color: '#64748b', fontFamily: MONO, fontSize: 10, lineHeight: 1.8 }}>
            {searchText ? `No results for\n"${searchText}"` : 'No tags.\nClick + to add one.'}
          </div>
        )}
        {groupKeys.map(key => (
          <TagGroup
            key={key}
            prefix={key}
            tags={groups[key]}
            selectedId={selectedTag?.id}
            activeId={activeTag?.id}
            searchText={searchText}
            onSelect={handleSelect}
          />
        ))}
      </div>

      {/* Tag detail card */}
      {selectedTag && (
        <TagDetailCard
          key={selectedTag.id}
          tag={selectedTag}
          onClose={() => setSelectedTag(null)}
          onUpdate={data => { onUpdateTag(data); setSelectedTag(prev => prev ? { ...prev, ...data } : null) }}
          onDelete={tagId => { onDeleteTag(tagId); setSelectedTag(null); onSelectTag(null) }}
          onCopy={(tagId, newId) => onCopyTag(tagId, newId)}
        />
      )}

      {/* Bottom action buttons */}
      <div style={{
        padding: 8, borderTop: '1px solid #081828', background: '#030e1a',
        display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0,
      }}>
        <button
          onClick={onAddDocs}
          onMouseEnter={() => setHoverAdd(true)}
          onMouseLeave={() => setHoverAdd(false)}
          style={{
            width: '100%', background: hoverAdd ? '#1e3a5f' : '#0d2035',
            border: '1px solid #1e3a5f', color: '#38bdf8',
            fontFamily: MONO, fontSize: 11,
            padding: 8, borderRadius: 3, cursor: 'pointer',
            transition: 'background .12s',
          }}
        >＋ Add Documents</button>
        <button
          onClick={handleCleanup}
          onMouseEnter={() => setHoverCleanup(true)}
          onMouseLeave={() => setHoverCleanup(false)}
          style={{
            width: '100%', background: '#030e1a',
            border: '1px solid #081828',
            color: cleanupMsg ? '#94a3b8' : hoverCleanup ? '#94a3b8' : '#64748b',
            fontFamily: MONO, fontSize: 10,
            padding: 6, borderRadius: 3, cursor: 'pointer',
            transition: 'color .12s',
          }}
        >{cleanupMsg ?? '🧹 Clean Orphaned Files'}</button>
        <button
          onClick={handleReindexClick}
          onMouseEnter={() => setHoverReindex(true)}
          onMouseLeave={() => setHoverReindex(false)}
          style={{
            width: '100%', background: '#030e1a',
            border: '1px solid #081828',
            color: reindexing ? '#94a3b8' : hoverReindex ? '#94a3b8' : '#64748b',
            fontFamily: MONO, fontSize: 10,
            padding: 6, borderRadius: 3, cursor: 'pointer',
            transition: 'color .12s',
          }}
        >{reindexing ? '↺ Re-indexing…' : '↺ Re-index Workspace'}</button>
      </div>
    </div>
  )
}

function TagGroup({ prefix, tags, selectedId, activeId, searchText, onSelect }) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <div
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', cursor: 'pointer', background: '#051525',
          borderBottom: '1px solid #081828', userSelect: 'none',
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 9, color: '#38bdf8', letterSpacing: .5, flex: 1 }}>
          {open ? '▾' : '▸'} {prefix}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 9, color: '#64748b' }}>{tags.length}</span>
      </div>
      {open && tags.filter(Boolean).map(tag => (
        <TagRow
          key={tag.id}
          tag={tag}
          selected={tag.id === selectedId}
          active={tag.id === activeId}
          searchText={searchText}
          onSelect={() => onSelect(tag)}
        />
      ))}
    </div>
  )
}

function TagRow({ tag, selected, active, searchText, onSelect }) {
  const [hover, setHover] = useState(false)
  const tagId      = tag.tag_id || tag.name || ''
  const statusColor = tag.status === 'active' ? '#22c55e' : tag.status === 'inactive' ? '#475569' : '#f59e0b'
  const docCount   = tag.doc_count ?? tag.docCount ?? 0
  const issueCount = tag.issue_count ?? tag.issueCount ?? 0

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 6,
        padding: '6px 10px 6px 12px',
        background: selected ? '#0d3a5c' : hover ? '#0d2035' : 'transparent',
        borderLeft: `3px solid ${active ? '#38bdf8' : 'transparent'}`,
        cursor: 'pointer', transition: 'all .1s',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, flexShrink: 0, marginTop: 3 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{
            fontFamily: MONO, fontSize: 10, color: '#38bdf8', fontWeight: 700,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
          }}>
            {highlightText(tagId, searchText)}
          </span>
          {docCount > 0 && (
            <span style={{ fontFamily: MONO, fontSize: 8, background: '#0d2035', color: '#64748b', border: '1px solid #1e3a5f', borderRadius: 8, padding: '0 4px', flexShrink: 0 }}>
              {docCount}
            </span>
          )}
          {issueCount > 0 && (
            <span style={{ fontFamily: MONO, fontSize: 8, background: '#7f1d1d', color: '#f87171', borderRadius: 8, padding: '0 4px', flexShrink: 0 }}>
              {issueCount}
            </span>
          )}
        </div>
        {tag.description && (
          <div style={{ fontFamily: SANS, fontSize: 9, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
            {highlightText(safeStr(tag.description).length > 38 ? safeStr(tag.description).slice(0, 38) + '…' : safeStr(tag.description), searchText)}
          </div>
        )}
      </div>
    </div>
  )
}

function AddTagForm({ onSave, onCancel }) {
  const [form, setForm] = useState({ tag_id: '', description: '', instrument_type: '', area: '', make: '', model: '', notes: '' })
  const iStyle = { width: '100%', background: '#0d2035', border: '1px solid #1e3a5f', color: '#e2e8f0', fontFamily: MONO, fontSize: 10, padding: '3px 6px', borderRadius: 3, outline: 'none', boxSizing: 'border-box', marginBottom: 4 }
  const lStyle = { fontFamily: MONO, fontSize: 8, color: '#64748b', marginBottom: 2, marginTop: 4, display: 'block' }

  return (
    <div style={{ padding: '8px 10px', borderBottom: '1px solid #081828', background: '#041220', flexShrink: 0 }}>
      <div style={{ fontFamily: MONO, fontSize: 9, color: '#38bdf8', marginBottom: 6, letterSpacing: .5 }}>NEW TAG</div>
      <label style={lStyle}>TAG ID *</label>
      <input
        autoFocus placeholder="e.g. FT-1001"
        value={form.tag_id}
        onChange={e => setForm(p => ({ ...p, tag_id: e.target.value }))}
        onKeyDown={e => e.key === 'Escape' && onCancel()}
        style={iStyle}
      />
      <label style={lStyle}>DESCRIPTION</label>
      <input
        placeholder="e.g. Flow Transmitter — Unit 3"
        value={form.description}
        onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
        style={iStyle}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 6px' }}>
        <div>
          <label style={lStyle}>INSTRUMENT TYPE</label>
          <input placeholder="FT" value={form.instrument_type} onChange={e => setForm(p => ({ ...p, instrument_type: e.target.value }))} style={iStyle} />
        </div>
        <div>
          <label style={lStyle}>AREA</label>
          <input placeholder="Default" value={form.area} onChange={e => setForm(p => ({ ...p, area: e.target.value }))} style={iStyle} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
        <button
          onClick={() => { if (form.tag_id.trim()) onSave(form) }}
          style={{ background: '#1d4ed8', border: 'none', color: '#ffffff', fontFamily: MONO, fontSize: 9, padding: '3px 10px', borderRadius: 3, cursor: 'pointer' }}
        >Add Tag</button>
        <button
          onClick={onCancel}
          style={{ background: '#0d2035', border: '1px solid #1e3a5f', color: '#94a3b8', fontFamily: MONO, fontSize: 9, padding: '3px 10px', borderRadius: 3, cursor: 'pointer' }}
        >Cancel</button>
      </div>
    </div>
  )
}

function TagDetailCard({ tag, onClose, onUpdate, onDelete, onCopy }) {
  const [editing,       setEditing]       = useState(false)
  const [copying,       setCopying]       = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [copyId,        setCopyId]        = useState('')
  const [form, setForm] = useState({
    tag_id:          tag.tag_id || tag.name || '',
    description:     tag.description     || '',
    instrument_type: tag.instrument_type || '',
    area:            tag.area            || '',
    make:            tag.make            || '',
    model:           tag.model           || '',
    status:          tag.status          || 'active',
    notes:           tag.notes           || '',
  })

  const tagId       = tag.tag_id || tag.name || ''
  const statusColor = tag.status === 'active' ? '#22c55e' : tag.status === 'inactive' ? '#475569' : '#f59e0b'
  const docCount    = tag.doc_count ?? tag.docCount ?? 0
  const issueCount  = tag.issue_count ?? tag.issueCount ?? 0

  const iStyle = { width: '100%', background: '#0d2035', border: '1px solid #1e3a5f', color: '#e2e8f0', fontFamily: MONO, fontSize: 10, padding: '3px 6px', borderRadius: 3, outline: 'none', boxSizing: 'border-box', marginBottom: 4 }
  const lStyle = { fontFamily: MONO, fontSize: 8, color: '#64748b', marginBottom: 2, marginTop: 4, display: 'block' }

  return (
    <div style={{ borderTop: '1px solid #081828', background: '#030e1a', padding: '10px 12px', flexShrink: 0, maxHeight: 340, overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <span style={{ fontFamily: MONO, fontSize: 12, color: '#38bdf8', fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tagId}
        </span>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 14, padding: '0 2px', flexShrink: 0 }}>×</button>
      </div>

      {/* Action buttons */}
      {!editing && !confirmDelete && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          <button onClick={() => setEditing(true)} style={{ background: '#0d2035', border: '1px solid #1e3a5f', color: '#e2e8f0', fontFamily: MONO, fontSize: 9, padding: '3px 8px', borderRadius: 3, cursor: 'pointer' }}>Edit</button>
          <button onClick={() => setCopying(v => !v)} style={{ background: '#0d2035', border: '1px solid #1e3a5f', color: '#e2e8f0', fontFamily: MONO, fontSize: 9, padding: '3px 8px', borderRadius: 3, cursor: 'pointer' }}>Copy</button>
          <button onClick={() => setConfirmDelete(true)} style={{ background: '#7f1d1d', border: '1px solid #991b1b', color: '#f87171', fontFamily: MONO, fontSize: 9, padding: '3px 8px', borderRadius: 3, cursor: 'pointer' }}>Delete</button>
        </div>
      )}

      {/* Copy input */}
      {copying && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          <input
            autoFocus placeholder="New tag ID…" value={copyId}
            onChange={e => setCopyId(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && setCopying(false)}
            style={{ flex: 1, background: '#0d2035', border: '1px solid #1e3a5f', color: '#e2e8f0', fontFamily: MONO, fontSize: 10, padding: '3px 6px', borderRadius: 3, outline: 'none' }}
          />
          <button onClick={() => { if (copyId.trim()) { onCopy(tagId, copyId.trim()); setCopying(false); setCopyId('') } }} style={{ background: '#1d4ed8', border: 'none', color: '#ffffff', fontFamily: MONO, fontSize: 9, padding: '3px 8px', borderRadius: 3, cursor: 'pointer' }}>Copy</button>
          <button onClick={() => { setCopying(false); setCopyId('') }} style={{ background: '#0d2035', border: '1px solid #1e3a5f', color: '#94a3b8', fontFamily: MONO, fontSize: 9, padding: '2px 6px', borderRadius: 3, cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <div style={{ marginBottom: 8, padding: '6px 8px', background: '#1c0a0a', border: '1px solid #7f1d1d', borderRadius: 4 }}>
          <div style={{ fontFamily: SANS, fontSize: 10, color: '#f87171', marginBottom: 6, lineHeight: 1.4 }}>
            Delete {tagId}? This will remove the tag and all linked data. Cannot be undone.
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => { onDelete(tagId); setConfirmDelete(false) }} style={{ background: '#7f1d1d', border: '1px solid #991b1b', color: '#f87171', fontFamily: MONO, fontSize: 9, padding: '3px 8px', borderRadius: 3, cursor: 'pointer' }}>Delete</button>
            <button onClick={() => setConfirmDelete(false)} style={{ background: '#0d2035', border: '1px solid #1e3a5f', color: '#94a3b8', fontFamily: MONO, fontSize: 9, padding: '3px 8px', borderRadius: 3, cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Edit form */}
      {editing ? (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 8px' }}>
            <div>
              <label style={lStyle}>TAG ID</label>
              <input disabled value={form.tag_id} style={{ ...iStyle, opacity: 0.5 }} />
            </div>
            <div>
              <label style={lStyle}>INSTRUMENT TYPE</label>
              <input value={form.instrument_type} onChange={e => setForm(p => ({ ...p, instrument_type: e.target.value }))} style={iStyle} />
            </div>
            <div>
              <label style={lStyle}>AREA / UNIT</label>
              <input value={form.area} onChange={e => setForm(p => ({ ...p, area: e.target.value }))} style={iStyle} />
            </div>
            <div>
              <label style={lStyle}>STATUS</label>
              <select value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))} style={{ ...iStyle, cursor: 'pointer' }}>
                <option value="active">active</option>
                <option value="inactive">inactive</option>
                <option value="unknown">unknown</option>
              </select>
            </div>
            <div>
              <label style={lStyle}>MAKE</label>
              <input value={form.make} onChange={e => setForm(p => ({ ...p, make: e.target.value }))} style={iStyle} />
            </div>
            <div>
              <label style={lStyle}>MODEL</label>
              <input value={form.model} onChange={e => setForm(p => ({ ...p, model: e.target.value }))} style={iStyle} />
            </div>
          </div>
          <label style={lStyle}>DESCRIPTION</label>
          <input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} style={iStyle} />
          <label style={lStyle}>NOTES</label>
          <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={2} style={{ ...iStyle, resize: 'none', fontFamily: SANS }} />
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <button onClick={() => { onUpdate({ ...form }); setEditing(false) }} style={{ background: '#1d4ed8', border: 'none', color: '#ffffff', fontFamily: MONO, fontSize: 9, padding: '3px 10px', borderRadius: 3, cursor: 'pointer' }}>Save Changes</button>
            <button onClick={() => setEditing(false)} style={{ background: '#0d2035', border: '1px solid #1e3a5f', color: '#94a3b8', fontFamily: MONO, fontSize: 9, padding: '3px 10px', borderRadius: 3, cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      ) : (
        /* View mode */
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px', marginBottom: 6 }}>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b' }}>TAG ID</div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: '#38bdf8' }}>{tagId}</div>
            </div>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b' }}>INSTRUMENT TYPE</div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: '#e2e8f0' }}>{tag.instrument_type || '—'}</div>
            </div>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b' }}>AREA / UNIT</div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: '#e2e8f0' }}>{tag.area || '—'}</div>
            </div>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b' }}>STATUS</div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: statusColor }}>{tag.status || 'unknown'}</div>
            </div>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b' }}>MAKE</div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: '#e2e8f0' }}>{tag.make || '—'}</div>
            </div>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b' }}>MODEL</div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: '#e2e8f0' }}>{tag.model || '—'}</div>
            </div>
          </div>
          {tag.description && (
            <div style={{ marginBottom: 4 }}>
              <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b' }}>DESCRIPTION</div>
              <div style={{ fontFamily: SANS, fontSize: 10, color: '#94a3b8', lineHeight: 1.4 }}>{tag.description}</div>
            </div>
          )}
          {tag.notes && (
            <div style={{ marginBottom: 4 }}>
              <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b' }}>NOTES</div>
              <div style={{ fontFamily: SANS, fontSize: 10, color: '#94a3b8', lineHeight: 1.4 }}>{tag.notes}</div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
            {docCount > 0   && <Badge bg='#0c2a1a' color='#34d399'>{docCount} docs</Badge>}
            {issueCount > 0 && <Badge bg='#7f1d1d' color='#f87171'>{issueCount} issues</Badge>}
            {tag.created_at && <span style={{ fontFamily: MONO, fontSize: 8, color: '#64748b' }}>{relativeTime(tag.created_at)}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Centre Panel ──────────────────────────────────────────────────────────────

function CentrePanel({ activeTag, messages, isLoading, inputText, onInputChange, onSend, onKeyDown, onAcceptDiff, onRejectDiff }) {
  const endRef = useRef(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  return (
    <div style={{
      flex: 1, minWidth: 0,
      background: BG,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Active tag header */}
      <div style={{
        padding: '10px 20px',
        borderBottom: `1px solid ${BORDER}`,
        background: PANEL, minHeight: 44,
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        {activeTag ? (
          <>
            <span style={{ fontFamily: MONO, fontSize: 13, color: ACCENT, fontWeight: 700 }}>
              {activeTag.name}
            </span>
            {activeTag.description && (
              <span style={{ fontFamily: SANS, fontSize: 12, color: TEXTM }}>
                — {activeTag.description}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <Badge bg={ACCENTD} color={ACCENT}>ACTIVE</Badge>
          </>
        ) : (
          <span style={{ fontFamily: MONO, fontSize: 10, color: TEXTD }}>
            No tag selected — select from file tree
          </span>
        )}
      </div>

      {/* Message history */}
      <div style={{
        flex: 1, overflowY: 'auto',
        padding: '20px 24px',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        {messages.map((msg, i) => (
          <MessageBubble
            key={i}
            msg={msg}
            onAcceptDiff={onAcceptDiff}
            onRejectDiff={onRejectDiff}
          />
        ))}
        {isLoading && <LoadingBubble />}
        <div ref={endRef} />
      </div>

      {/* Input area */}
      <div style={{
        padding: '12px 20px',
        borderTop: `1px solid ${BORDER}`,
        background: PANEL,
      }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <textarea
            value={inputText}
            onChange={e => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={activeTag
              ? `Ask about ${activeTag.name} — field values, conflicts, wiring…`
              : 'Select a tag then ask a question…'
            }
            rows={2}
            style={{
              flex: 1, background: PANEL2,
              border: `1px solid ${BORDER2}`,
              borderRadius: 6, padding: '10px 14px',
              color: TEXT, fontFamily: SANS, fontSize: 13,
              resize: 'none', outline: 'none',
              lineHeight: 1.5,
            }}
          />
          <button
            onClick={onSend}
            disabled={isLoading || !inputText.trim()}
            style={{
              background: isLoading || !inputText.trim() ? BORDER : ACCENTD,
              border: `1px solid ${isLoading || !inputText.trim() ? BORDER : ACCENT + '60'}`,
              color: isLoading || !inputText.trim() ? TEXTM : ACCENT,
              fontFamily: MONO, fontSize: 10, fontWeight: 700,
              padding: '10px 16px', borderRadius: 6, cursor: isLoading ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
              transition: 'all .15s', letterSpacing: .5,
            }}
          >
            {isLoading ? <Spinner /> : '↑'}
            {isLoading ? 'THINKING' : 'SEND'}
          </button>
        </div>
        <div style={{
          marginTop: 7, fontFamily: MONO, fontSize: 9, color: TEXTD,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ color: OK, fontSize: 8 }}>●</span>
          Grounded in your documents only · Enter to send · Shift+Enter for new line
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ msg, onAcceptDiff, onRejectDiff }) {
  const isUser = msg.role === 'user'
  const { body: body1, diff }  = parseDiff(msg.text)
  const { body: finalBody, srcs } = parseSources(body1)

  const allSrcs = [...(srcs ?? []), ...(msg.citations ?? [])]

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 14,
      animation: 'engram-fadein .2s ease-out',
    }}>
      {!isUser && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
          <Badge bg={ACCENT} color={BG}>ENGRAM</Badge>
        </div>
      )}

      <div style={{
        maxWidth: '78%',
        background: isUser ? '#0d2035' : PANEL2,
        border: `1px solid ${isUser ? '#0f3050' : BORDER}`,
        borderRadius: isUser ? '10px 10px 2px 10px' : '2px 10px 10px 10px',
        padding: '10px 14px',
        color: TEXT, fontSize: 13, fontFamily: SANS, lineHeight: 1.65,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {finalBody}
      </div>

      {diff && (
        <DiffBlock diff={diff} onAccept={() => onAcceptDiff(diff)} onReject={() => onRejectDiff(diff)} />
      )}

      {allSrcs.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5, maxWidth: '78%' }}>
          {allSrcs.map((s, i) => (
            <span key={i} style={{
              background: ACCENTD, color: ACCENT,
              fontSize: 9, fontFamily: MONO,
              padding: '2px 7px', borderRadius: 3,
            }}>
              {s.fn ?? s.filename}
              {(s.dt ?? s.doc_type) && ` · ${s.dt ?? s.doc_type}`}
              {(s.rv ?? s.revision) && ` · ${s.rv ?? s.revision}`}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function DiffBlock({ diff, onAccept, onReject }) {
  return (
    <div style={{
      marginTop: 8, border: `1px solid ${BORDER}`,
      borderRadius: 6, overflow: 'hidden', minWidth: 280, maxWidth: 420,
    }}>
      <div style={{
        background: PANEL2, padding: '5px 12px',
        fontFamily: MONO, fontSize: 9, color: TEXTM, letterSpacing: 1,
        borderBottom: `1px solid ${BORDER}`,
      }}>
        PROPOSED CHANGE · {diff.field}
      </div>
      <div style={{ padding: '10px 14px', background: '#040c10', fontFamily: MONO, fontSize: 12 }}>
        <div style={{ color: ERR, marginBottom: 5 }}>− {diff.oldVal}</div>
        <div style={{ color: OK }}>+ {diff.newVal}</div>
      </div>
      <div style={{
        display: 'flex', gap: 8, padding: '7px 12px',
        background: PANEL2, borderTop: `1px solid ${BORDER}`,
      }}>
        <SmallButton color={OK} onClick={onAccept} label="ACCEPT" />
        <SmallButton color={ERR} onClick={onReject} label="REJECT" />
      </div>
    </div>
  )
}

function SmallButton({ color, onClick, label }) {
  const [h, setH] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        background: h ? color + '30' : color + '18',
        border: `1px solid ${color}50`,
        color, fontFamily: MONO, fontSize: 9, fontWeight: 700,
        padding: '4px 12px', borderRadius: 4, cursor: 'pointer',
        letterSpacing: .5, transition: 'all .12s',
      }}
    >
      {label}
    </button>
  )
}

function LoadingBubble() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <Badge bg={ACCENT} color={BG}>ENGRAM</Badge>
      <div style={{
        background: PANEL2, border: `1px solid ${BORDER}`,
        borderRadius: '2px 10px 10px 10px',
        padding: '10px 14px', display: 'flex', gap: 5, alignItems: 'center',
      }}>
        {[0, 1, 2].map(i => (
          <span key={i} style={{
            width: 6, height: 6, borderRadius: '50%', background: ACCENT,
            animation: `engram-pulse 1.2s ease-in-out ${i * .2}s infinite`,
            display: 'inline-block',
          }} />
        ))}
      </div>
    </div>
  )
}

// ── Right Panel ───────────────────────────────────────────────────────────────

const TABS = ['DOCS', 'ISSUES', 'WIRING', 'HISTORY', 'STANDARDS']

// ── Standards Tab ─────────────────────────────────────────────────────────────

const STD_PURPLE = '#a855f7'
const STD_PURPLED = '#3b0764'

function StandardsTab({ standards, onDelete, onAdd }) {
  const [addFile,       setAddFile]       = useState(null)   // File object from browser picker
  const [addTitle,      setAddTitle]      = useState('')
  const [addCat,        setAddCat]        = useState('General')
  const [addYear,       setAddYear]       = useState('')
  const [addForm,       setAddForm]       = useState(false)
  const [folderForm,    setFolderForm]    = useState(false)
  const [folderPath,    setFolderPath]    = useState('')      // server-side path
  const [busy,          setBusy]          = useState(false)
  const [err,           setErr]           = useState('')
  const fileInputRef = useRef(null)

  // Group by category
  const byCategory = {}
  for (const s of (standards ?? [])) {
    const cat = s.category || 'General'
    if (!byCategory[cat]) byCategory[cat] = []
    byCategory[cat].push(s)
  }

  async function handleAdd() {
    if (!addFile) return
    setBusy(true); setErr('')
    try {
      const formData = new FormData()
      formData.append('file', addFile)
      if (addTitle.trim()) formData.append('title',    addTitle.trim())
      formData.append('category', addCat.trim() || 'General')
      if (addYear.trim())  formData.append('year',     addYear.trim())
      const res = await fetch('/api/standards/add', {
        method: 'POST',
        headers: { 'x-engram-token': TOKEN },
        body: formData,
      }).then(r => r.json())
      if (res?.ok) {
        setAddForm(false); setAddFile(null); setAddTitle(''); setAddYear('')
        onAdd?.()
      } else {
        setErr(res?.error ?? 'Failed')
      }
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  async function handleAddFolder() {
    if (!folderPath.trim()) return
    setBusy(true); setErr('')
    try {
      const res = await api('POST', '/api/standards/addFolder', {
        folderPath: folderPath.trim(),
        category:  addCat.trim() || 'General',
      })
      if (res?.ok) { setFolderForm(false); setFolderPath(''); onAdd?.() }
      else setErr(res?.error ?? 'Failed')
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '10px 12px', borderBottom: `1px solid ${BORDER}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
      }}>
        <span style={{ fontFamily: MONO, fontSize: 9, color: STD_PURPLE, letterSpacing: 1 }}>
          STANDARDS & POLICY
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => { setFolderForm(f => !f); setAddForm(false) }} disabled={busy} style={{
            background: folderForm ? STD_PURPLED : 'transparent',
            border: `1px solid ${STD_PURPLE}40`,
            color: STD_PURPLE, fontFamily: MONO, fontSize: 8, padding: '3px 8px',
            borderRadius: 3, cursor: 'pointer',
          }}>+ FOLDER</button>
          <button onClick={() => { setAddForm(f => !f); setFolderForm(false) }} style={{
            background: addForm ? STD_PURPLED : 'transparent',
            border: `1px solid ${STD_PURPLE}40`,
            color: STD_PURPLE, fontFamily: MONO, fontSize: 8, padding: '3px 8px',
            borderRadius: 3, cursor: 'pointer',
          }}>+ FILE</button>
        </div>
      </div>

      {/* Hidden file input — triggered by "Choose File" button below */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.docx,.doc,.xlsx,.xls,.txt"
        style={{ display: 'none' }}
        onChange={e => { setAddFile(e.target.files[0] ?? null); setAddForm(true) }}
      />

      {/* Folder path form — user types a server-side folder path */}
      {folderForm && (
        <div style={{
          padding: '10px 12px', borderBottom: `1px solid ${BORDER}`,
          background: '#0d0620', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0,
        }}>
          <input
            placeholder="Server folder path (e.g. C:\standards)"
            value={folderPath}
            onChange={e => setFolderPath(e.target.value)}
            style={{
              background: BORDER2, border: `1px solid ${STD_PURPLE}30`, color: TEXT,
              fontFamily: MONO, fontSize: 9, padding: '4px 8px', borderRadius: 3, outline: 'none',
            }}
          />
          <input
            placeholder="Category"
            value={addCat}
            onChange={e => setAddCat(e.target.value)}
            style={{
              background: BORDER2, border: `1px solid ${STD_PURPLE}30`, color: TEXT,
              fontFamily: MONO, fontSize: 9, padding: '4px 8px', borderRadius: 3, outline: 'none',
            }}
          />
          {err && <div style={{ fontFamily: MONO, fontSize: 9, color: ERR }}>{err}</div>}
          <button onClick={handleAddFolder} disabled={busy || !folderPath.trim()} style={{
            background: STD_PURPLE, border: 'none', color: '#fff',
            fontFamily: MONO, fontSize: 9, padding: '5px', borderRadius: 3, cursor: 'pointer',
          }}>{busy ? 'Adding…' : 'Index Folder'}</button>
        </div>
      )}

      {/* Add file form */}
      {addForm && (
        <div style={{
          padding: '10px 12px', borderBottom: `1px solid ${BORDER}`,
          background: '#0d0620', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0,
        }}>
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{
              background: BORDER2, border: `1px solid ${STD_PURPLE}30`, color: addFile ? TEXT : TEXTM,
              fontFamily: MONO, fontSize: 9, padding: '4px 8px', borderRadius: 3,
              cursor: 'pointer', textAlign: 'left',
            }}
          >
            {addFile ? addFile.name : 'Choose file…'}
          </button>
          <input
            placeholder="Title (optional)"
            value={addTitle}
            onChange={e => setAddTitle(e.target.value)}
            style={{
              background: BORDER2, border: `1px solid ${STD_PURPLE}30`, color: TEXT,
              fontFamily: MONO, fontSize: 9, padding: '4px 8px', borderRadius: 3, outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              placeholder="Category"
              value={addCat}
              onChange={e => setAddCat(e.target.value)}
              style={{
                flex: 1, background: BORDER2, border: `1px solid ${STD_PURPLE}30`, color: TEXT,
                fontFamily: MONO, fontSize: 9, padding: '4px 8px', borderRadius: 3, outline: 'none',
              }}
            />
            <input
              placeholder="Year"
              value={addYear}
              onChange={e => setAddYear(e.target.value)}
              style={{
                width: 60, background: BORDER2, border: `1px solid ${STD_PURPLE}30`, color: TEXT,
                fontFamily: MONO, fontSize: 9, padding: '4px 8px', borderRadius: 3, outline: 'none',
              }}
            />
          </div>
          {err && <div style={{ fontFamily: MONO, fontSize: 9, color: ERR }}>{err}</div>}
          <button onClick={handleAdd} disabled={busy || !addFile} style={{
            background: STD_PURPLE, border: 'none', color: '#fff',
            fontFamily: MONO, fontSize: 9, padding: '5px', borderRadius: 3, cursor: 'pointer',
          }}>{busy ? 'Adding…' : 'Add Standard'}</button>
        </div>
      )}

      {/* Document list + Registry — scrollable area */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 0' }}>
          {Object.keys(byCategory).length === 0 ? (
            <div style={{
              padding: 24, textAlign: 'center',
              color: TEXTD, fontFamily: MONO, fontSize: 10, lineHeight: 1.8,
            }}>
              No standards indexed.<br />Add files or a folder above.
            </div>
          ) : (
            Object.entries(byCategory).map(([cat, items]) => (
              <div key={cat}>
                <div style={{
                  padding: '4px 12px', fontFamily: MONO, fontSize: 8,
                  color: STD_PURPLE, letterSpacing: 1, textTransform: 'uppercase',
                  borderBottom: `1px solid ${BORDER}`, marginBottom: 2,
                }}>{cat}</div>
                {items.filter(Boolean).map(s => (
                  <div key={s.id} style={{
                    padding: '6px 12px', display: 'flex', alignItems: 'flex-start',
                    gap: 8, borderBottom: `1px solid ${BORDER}08`,
                  }}>
                    <div style={{
                      width: 3, height: 3, borderRadius: '50%',
                      background: STD_PURPLE, flexShrink: 0, marginTop: 5,
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontFamily: MONO, fontSize: 9, color: TEXT,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{s.title || s.filename}</div>
                      <div style={{ fontFamily: MONO, fontSize: 8, color: TEXTM, marginTop: 1 }}>
                        {s.year ? `${s.year} · ` : ''}{s.filename}
                      </div>
                    </div>
                    <button onClick={() => onDelete?.(s.id)} style={{
                      background: 'transparent', border: 'none', color: TEXTM,
                      cursor: 'pointer', fontSize: 10, padding: '0 2px', flexShrink: 0,
                    }} title="Remove">×</button>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        {/* Standards Registry notepad */}
        <div style={{ borderTop: `1px solid ${BORDER}` }}>
          <RegistryNotepad />
        </div>
      </div>
    </div>
  )
}

const REG_CATS = ['General', 'Instrumentation', 'Safety', 'Process Control', 'Electrical', 'Mechanical', 'Environmental', 'Quality']

const REG_DEFAULTS = [
  { standard_number: 'ISA-5.1',     standard_name: 'Instrumentation Symbols',  category: 'Instrumentation', notes: '' },
  { standard_number: 'ISA-18.2',    standard_name: 'Alarm Management',          category: 'Instrumentation', notes: '' },
  { standard_number: 'IEC 61511',   standard_name: 'Functional Safety',         category: 'Safety',          notes: '' },
  { standard_number: 'ISA-88',      standard_name: 'Batch Control',             category: 'Process Control', notes: '' },
  { standard_number: 'ISO 10628-2', standard_name: 'P&ID Symbols',              category: 'Engineering',     notes: '' },
]

const INPUT_STYLE = {
  background: 'transparent', border: 'none',
  borderBottom: '1px solid #0d2035',
  color: 'inherit', padding: '4px 6px',
  fontFamily: '"IBM Plex Mono", monospace',
  fontSize: 11, outline: 'none',
}

function RegistryNotepad() {
  const [rows,   setRows]   = useState([])
  const [saved,  setSaved]  = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api('GET', '/api/registry/list')
      .then(res => {
        if (res?.ok) {
          const items = res.standards ?? []
          setRows(items.length > 0 ? items : REG_DEFAULTS.map((d, i) => ({ ...d, id: -(i + 1) })))
        }
      })
      .catch(() => setRows(REG_DEFAULTS.map((d, i) => ({ ...d, id: -(i + 1) }))))
  }, [])

  function updateRow(idx, field, value) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r))
    setSaved(false)
  }

  function addRow() {
    setRows(prev => [...prev, { id: -Date.now(), standard_number: '', standard_name: '', category: 'General', notes: '' }])
    setSaved(false)
  }

  function removeRow(idx) {
    setRows(prev => prev.filter((_, i) => i !== idx))
    setSaved(false)
  }

  async function handleSave() {
    setSaving(true)
    try {
      await api('POST', '/api/registry/save', rows)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (_) {}
    setSaving(false)
  }

  return (
    <div style={{
      margin: '12px 10px 10px',
      background: '#020c16', border: `1px solid ${BORDER2}`,
      borderRadius: 6, padding: 12,
    }}>
      {/* Section header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10,
      }}>
        <div>
          <div style={{ fontFamily: MONO, fontSize: 10, color: TEXT, marginBottom: 2 }}>
            Standards Registry
          </div>
          <div style={{ fontFamily: MONO, fontSize: 8, color: TEXTM }}>
            Standards applied to all reviews
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%',
            background: OK, flexShrink: 0,
          }} />
          <span style={{ fontFamily: MONO, fontSize: 9, color: OK }}>
            {rows.filter(r => r.standard_number?.trim()).length} active
          </span>
        </div>
      </div>

      {/* Rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map((row, idx) => (
          <div key={row.id ?? idx} style={{ display: 'flex', alignItems: 'center', gap: 0, borderBottom: `1px solid ${BORDER}` }}>
            <input
              value={row.standard_number ?? ''}
              onChange={e => updateRow(idx, 'standard_number', e.target.value)}
              placeholder="ISA-5.1"
              style={{ ...INPUT_STYLE, width: 90, color: ACCENT }}
              onFocus={e => e.target.style.borderBottomColor = ACCENT}
              onBlur={e => e.target.style.borderBottomColor = '#0d2035'}
            />
            <input
              value={row.standard_name ?? ''}
              onChange={e => updateRow(idx, 'standard_name', e.target.value)}
              placeholder="Description"
              style={{ ...INPUT_STYLE, width: 150, color: TEXT }}
              onFocus={e => e.target.style.borderBottomColor = ACCENT}
              onBlur={e => e.target.style.borderBottomColor = '#0d2035'}
            />
            <select
              value={row.category ?? 'General'}
              onChange={e => updateRow(idx, 'category', e.target.value)}
              style={{
                ...INPUT_STYLE, width: 120, color: TEXTM,
                appearance: 'none', cursor: 'pointer',
              }}
              onFocus={e => e.target.style.borderBottomColor = ACCENT}
              onBlur={e => e.target.style.borderBottomColor = '#0d2035'}
            >
              {REG_CATS.map(c => <option key={c} value={c} style={{ background: PANEL }}>{c}</option>)}
            </select>
            <input
              value={row.notes ?? ''}
              onChange={e => updateRow(idx, 'notes', e.target.value)}
              placeholder="Scope or notes..."
              style={{ ...INPUT_STYLE, flex: 1, color: '#94a3b8' }}
              onFocus={e => e.target.style.borderBottomColor = ACCENT}
              onBlur={e => e.target.style.borderBottomColor = '#0d2035'}
            />
            <button
              onClick={() => removeRow(idx)}
              style={{
                background: 'transparent', border: 'none',
                color: '#f87171', cursor: 'pointer',
                fontFamily: MONO, fontSize: 14, width: 24, flexShrink: 0, padding: 0,
              }}
              title="Remove"
            >×</button>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
        <button
          onClick={addRow}
          style={{
            background: 'transparent', border: 'none',
            color: ACCENT, fontFamily: MONO, fontSize: 11, cursor: 'pointer', padding: 0,
          }}
        >+ Add Row</button>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            background: BORDER2, border: `1px solid #1e3a5f`,
            color: saved ? OK : ACCENT,
            fontFamily: MONO, fontSize: 10, padding: '4px 12px',
            borderRadius: 3, cursor: 'pointer',
          }}
        >{saved ? '✓ Saved' : saving ? 'Saving…' : '💾 Save Registry'}</button>
      </div>
    </div>
  )
}

function RightPanel({ activeTag, allDocs, projects, currentProject, issues, activeTab, onTabChange, onClassifyIssue, onDeleteDoc, onReindexAll, onSetProject, onNewProject, onRenameDoc, standards, onStandardsRefresh }) {
  return (
    <div style={{
      width: 280, flexShrink: 0,
      background: PANEL, borderLeft: `1px solid ${BORDER}`,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', borderBottom: `1px solid ${BORDER}`,
        flexShrink: 0,
      }}>
        {TABS.map(tab => {
          const isStd    = tab === 'STANDARDS'
          const tabColor = activeTab === tab ? (isStd ? STD_PURPLE : ACCENT) : TEXTM
          const tabBorder = activeTab === tab ? (isStd ? STD_PURPLE : ACCENT) : 'transparent'
          return (
            <button
              key={tab}
              onClick={() => onTabChange(tab)}
              style={{
                flex: 1, background: 'transparent',
                border: 'none', borderBottom: `2px solid ${tabBorder}`,
                color: tabColor,
                fontFamily: MONO, fontSize: 7, fontWeight: 700,
                padding: '10px 0', cursor: 'pointer',
                letterSpacing: .6, transition: 'color .15s',
              }}
            >
              {tab}
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'STANDARDS' ? (
          <StandardsTab
            standards={standards}
            onDelete={async (id) => { await api('POST', '/api/standards/delete', { stdId: id }); onStandardsRefresh?.() }}
            onAdd={onStandardsRefresh}
          />
        ) : activeTab === 'DOCS' ? (
          <DocsTreeTab
            docs={allDocs}
            projects={projects}
            currentProject={currentProject}
            onDelete={onDeleteDoc}
            onReindexAll={onReindexAll}
            onSetProject={onSetProject}
            onNewProject={onNewProject}
            onRename={onRenameDoc}
          />
        ) : !activeTag ? (
          <div style={{
            padding: 24, textAlign: 'center',
            color: TEXTD, fontFamily: MONO, fontSize: 10, lineHeight: 1.8,
          }}>
            Select a tag to view context
          </div>
        ) : (
          <>
            {activeTab === 'ISSUES'  && <IssuesTab issues={issues} onClassify={onClassifyIssue} />}
            {activeTab === 'WIRING'  && <WiringTab tagId={activeTag.id} />}
            {activeTab === 'HISTORY' && <HistoryTab tagId={activeTag.id} />}
          </>
        )}
      </div>
    </div>
  )
}

function DocumentsTab({ docs }) {
  if (!docs?.length) return <EmptyState text="No documents indexed for this tag." />

  return (
    <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {docs.filter(Boolean).map(doc => (
        <DocCard key={doc.id} doc={doc} />
      ))}
    </div>
  )
}

function DocCard({ doc }) {
  const color = docTypeColor(doc.file_type ?? '')
  return (
    <div style={{
      background: PANEL2, border: `1px solid ${BORDER}`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 4, padding: '8px 10px',
    }}>
      <div style={{
        fontFamily: MONO, fontSize: 10, color: TEXT,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        marginBottom: 4,
      }}>
        {doc.title}
      </div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge bg={color + '25'} color={color}>{doc.file_type}</Badge>
        {doc.revision && <Badge bg={BORDER2} color={TEXTM}>Rev {doc.revision}</Badge>}
        {doc.status && doc.status !== 'active' && (
          <Badge bg={WARN + '20'} color={WARN}>{doc.status}</Badge>
        )}
      </div>
    </div>
  )
}

// ── DocsTreeTab — project-based document tree ──────────────────────────────

function DocsTreeTab({ docs, projects, currentProject, onDelete, onReindexAll, onSetProject, onNewProject, onRename }) {
  const [selectedDoc,  setSelectedDoc]  = useState(null)
  const [newProjName,  setNewProjName]  = useState('')
  const [showNewProj,  setShowNewProj]  = useState(false)
  const [searchText,   setSearchText]   = useState('')

  const searchLower = searchText.toLowerCase()

  const projectFiltered = currentProject === '__ALL__'
    ? docs
    : docs.filter(d => (d.project_name ?? 'Default') === currentProject)

  const filtered = !searchLower ? projectFiltered : projectFiltered.filter(d => {
    const name = (d.display_name || d.title || '').toLowerCase()
    const desc = (d.description || '').toLowerCase()
    return name.includes(searchLower) || desc.includes(searchLower) ||
      (d.title || '').toLowerCase().includes(searchLower) ||
      (d.project_name || '').toLowerCase().includes(searchLower)
  })

  const groups = {}
  for (const doc of filtered) {
    const key = getFileGroup(doc.title)
    if (!groups[key]) groups[key] = []
    groups[key].push(doc)
  }
  const groupKeys = Object.keys(groups).sort()

  const handleNewProject = () => {
    const name = newProjName.trim()
    if (!name) return
    onNewProject(name)
    setNewProjName('')
    setShowNewProj(false)
  }

  const handleRename = useCallback((docId, name, desc) => {
    onRename(docId, name, desc)
    if (selectedDoc?.id === docId) {
      setSelectedDoc(prev => prev ? { ...prev, display_name: name || null, description: desc || null } : null)
    }
  }, [onRename, selectedDoc?.id])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Project selector bar */}
      <div style={{ padding: '8px 10px', borderBottom: `1px solid ${BORDER}`, background: PANEL2, flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 5, marginBottom: 6, alignItems: 'center' }}>
          <select
            value={currentProject}
            onChange={e => onSetProject(e.target.value)}
            style={{
              flex: 1, background: '#0d2035', border: '1px solid #1e3a5f',
              color: TEXT, fontFamily: MONO, fontSize: 10, padding: '4px 6px',
              borderRadius: 3, cursor: 'pointer', outline: 'none',
            }}
          >
            <option value="__ALL__">All Projects ({docs.length})</option>
            {projects.filter(Boolean).map(p => (
              <option key={p} value={p}>
                {p} ({docs.filter(d => (d.project_name ?? 'Default') === p).length})
              </option>
            ))}
          </select>
          <button
            onClick={() => setShowNewProj(v => !v)}
            title="New project"
            style={{
              background: '#0d2035', border: '1px solid #1e3a5f',
              color: ACCENT, fontFamily: MONO, fontSize: 14,
              padding: '2px 8px', borderRadius: 3, cursor: 'pointer', lineHeight: 1,
            }}
          >+</button>
        </div>

        {showNewProj && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
            <input
              autoFocus
              placeholder="Project name…"
              value={newProjName}
              onChange={e => setNewProjName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleNewProject()
                if (e.key === 'Escape') setShowNewProj(false)
              }}
              style={{
                flex: 1, background: '#0d2035', border: '1px solid #1e3a5f',
                color: TEXT, fontFamily: MONO, fontSize: 10,
                padding: '4px 6px', borderRadius: 3, outline: 'none',
              }}
            />
            <button
              onClick={handleNewProject}
              style={{
                background: '#1d4ed8', border: 'none',
                color: '#ffffff', fontFamily: MONO, fontSize: 10,
                padding: '4px 8px', borderRadius: 3, cursor: 'pointer',
              }}
            >Create</button>
          </div>
        )}

        <button
          onClick={onReindexAll}
          style={{
            width: '100%', background: '#0d2035', border: '1px solid #1e3a5f',
            color: '#94a3b8', fontFamily: MONO, fontSize: 9,
            padding: '5px 8px', borderRadius: 3, cursor: 'pointer', letterSpacing: .5,
          }}
        >↺ RE-INDEX ALL</button>
      </div>

      {/* Search box */}
      <div style={{ padding: '6px 10px', borderBottom: `1px solid ${BORDER}`, flexShrink: 0 }}>
        <input
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          placeholder="Search documents…"
          style={{
            width: '100%', background: '#0d2035', border: `1px solid ${searchText ? ACCENT + '60' : '#1e3a5f'}`,
            color: TEXT, fontFamily: MONO, fontSize: 10,
            padding: '4px 8px', borderRadius: 3, outline: 'none', boxSizing: 'border-box',
          }}
        />
        {searchText && filtered.length === 0 && (
          <div style={{ fontFamily: MONO, fontSize: 9, color: '#64748b', marginTop: 4 }}>
            No results for "{searchText}"
          </div>
        )}
      </div>

      {/* File tree */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {!searchText && filtered.length === 0 && <EmptyState text="No documents in this project." />}
        {groupKeys.map(key => (
          <FileTypeGroup
            key={key}
            label={key}
            docs={groups[key]}
            selectedId={selectedDoc?.id}
            searchText={searchText}
            onSelect={setSelectedDoc}
            onDelete={docId => { onDelete(docId); if (selectedDoc?.id === docId) setSelectedDoc(null) }}
            onRename={handleRename}
          />
        ))}
      </div>

      {/* Detail panel */}
      {selectedDoc && (
        <DocDetailPanel
          key={selectedDoc.id}
          doc={selectedDoc}
          onClose={() => setSelectedDoc(null)}
          onDelete={() => { onDelete(selectedDoc.id); setSelectedDoc(null) }}
          onRename={handleRename}
        />
      )}
    </div>
  )
}

function FileTypeGroup({ label, docs, selectedId, searchText, onSelect, onDelete, onRename }) {
  const [open, setOpen] = useState(true)
  const color = getGroupColor(label)
  return (
    <div>
      <div
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', cursor: 'pointer', background: '#051525',
          borderBottom: `1px solid ${BORDER}`, userSelect: 'none',
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 9, color, letterSpacing: .5, flex: 1 }}>
          {open ? '▾' : '▸'} {label}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 9, color: '#64748b' }}>{docs.length}</span>
      </div>
      {open && docs.filter(Boolean).map(doc => (
        <DocTreeRow
          key={doc.id}
          doc={doc}
          selected={doc.id === selectedId}
          searchText={searchText}
          onSelect={() => onSelect(doc)}
          onDelete={() => onDelete(doc.id)}
          onRename={onRename}
        />
      ))}
    </div>
  )
}

function DocTreeRow({ doc, selected, searchText, onSelect, onDelete, onRename }) {
  const [hover,    setHover]    = useState(false)
  const [editing,  setEditing]  = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')

  const color       = fileTypeBadgeColor(doc.file_type)
  const displayName = doc.display_name || doc.title

  const startEdit = e => {
    e.stopPropagation()
    setEditName(doc.display_name || '')
    setEditDesc(doc.description || '')
    setEditing(true)
  }

  const saveEdit = e => {
    e?.stopPropagation()
    onRename(doc.id, editName.trim(), editDesc.trim())
    setEditing(false)
  }

  const cancelEdit = e => {
    e?.stopPropagation()
    setEditing(false)
  }

  return (
    <div>
      <div
        onClick={editing ? undefined : onSelect}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 6,
          padding: '6px 10px 6px 20px',
          background: selected ? '#0d3a5c' : hover ? '#0d2035' : 'transparent',
          borderLeft: selected ? `3px solid ${ACCENT}` : `3px solid transparent`,
          cursor: editing ? 'default' : 'pointer', transition: 'all .1s',
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 1, background: color, flexShrink: 0, marginTop: 3 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              fontFamily: MONO, fontSize: 10, color: selected ? ACCENT : TEXT,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>
              {highlightText(displayName, searchText)}
            </span>
            {(hover || selected) && !editing && (
              <>
                <button
                  onClick={startEdit}
                  title="Edit name/description"
                  style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 10, padding: '0 2px', flexShrink: 0 }}
                >✏</button>
                <button
                  onClick={e => { e.stopPropagation(); onDelete() }}
                  title="Remove"
                  style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 14, padding: '0 2px', flexShrink: 0 }}
                >×</button>
              </>
            )}
          </div>
          {doc.display_name && (
            <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {highlightText(doc.title, searchText)}
            </div>
          )}
          {doc.description && (
            <div style={{ fontFamily: SANS, fontSize: 9, color: TEXTM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
              {highlightText(
                safeStr(doc.description).length > 60 ? safeStr(doc.description).slice(0, 60) + '…' : safeStr(doc.description),
                searchText
              )}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            padding: '6px 10px 8px 28px',
            background: '#051525', borderLeft: `3px solid ${ACCENT}`,
            borderBottom: `1px solid ${BORDER}`,
          }}
        >
          <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b', marginBottom: 3 }}>DISPLAY NAME</div>
          <input
            autoFocus
            value={editName}
            onChange={e => setEditName(e.target.value)}
            placeholder={doc.title}
            onKeyDown={e => { if (e.key === 'Enter') saveEdit(e); if (e.key === 'Escape') cancelEdit(e) }}
            style={{
              width: '100%', background: '#0d2035', border: '1px solid #1e3a5f',
              color: TEXT, fontFamily: MONO, fontSize: 10,
              padding: '4px 6px', borderRadius: 3, outline: 'none',
              marginBottom: 6, boxSizing: 'border-box',
            }}
          />
          <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b', marginBottom: 3 }}>DESCRIPTION</div>
          <input
            value={editDesc}
            onChange={e => setEditDesc(e.target.value)}
            placeholder="Add a description…"
            onKeyDown={e => { if (e.key === 'Escape') cancelEdit(e) }}
            style={{
              width: '100%', background: '#0d2035', border: '1px solid #1e3a5f',
              color: TEXT, fontFamily: MONO, fontSize: 10,
              padding: '4px 6px', borderRadius: 3, outline: 'none',
              marginBottom: 6, boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={saveEdit}
              style={{ background: '#1d4ed8', border: 'none', color: '#ffffff', fontFamily: MONO, fontSize: 9, padding: '3px 10px', borderRadius: 3, cursor: 'pointer' }}
            >Save</button>
            <button
              onClick={cancelEdit}
              style={{ background: '#0d2035', border: '1px solid #1e3a5f', color: '#94a3b8', fontFamily: MONO, fontSize: 9, padding: '3px 10px', borderRadius: 3, cursor: 'pointer' }}
            >Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

function DocDetailPanel({ doc, onClose, onDelete, onRename }) {
  const [editingName, setEditingName] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [nameVal,     setNameVal]     = useState(doc.display_name || '')
  const [descVal,     setDescVal]     = useState(doc.description  || '')
  const [fields,      setFields]      = useState(null)

  useEffect(() => {
    api('GET', `/api/docs/fields/${doc.id}`)
      .then(res => setFields(res?.ok ? res.fields ?? [] : []))
      .catch(() => setFields([]))
  }, [doc.id])

  const saveName = () => {
    onRename(doc.id, nameVal.trim(), descVal.trim())
    setEditingName(false)
  }

  const saveDesc = () => {
    onRename(doc.id, nameVal.trim(), descVal.trim())
    setEditingDesc(false)
  }

  const color = fileTypeBadgeColor(doc.file_type)

  return (
    <div style={{ borderTop: `1px solid ${BORDER}`, background: '#030e1a', padding: '10px 12px', flexShrink: 0, maxHeight: 300, overflowY: 'auto' }}>
      {/* Close */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: TEXTM, cursor: 'pointer', fontSize: 14, padding: '0 2px' }}>×</button>
      </div>

      {/* Display name (editable) */}
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b', marginBottom: 2 }}>DISPLAY NAME</div>
        {editingName ? (
          <input
            autoFocus
            value={nameVal}
            onChange={e => setNameVal(e.target.value)}
            placeholder={doc.title}
            onBlur={saveName}
            onKeyDown={e => {
              if (e.key === 'Enter') saveName()
              if (e.key === 'Escape') { setNameVal(doc.display_name || ''); setEditingName(false) }
            }}
            style={{ width: '100%', background: '#0d2035', border: `1px solid ${ACCENT}`, color: TEXT, fontFamily: MONO, fontSize: 10, padding: '3px 6px', borderRadius: 3, outline: 'none', boxSizing: 'border-box' }}
          />
        ) : (
          <div
            onClick={() => setEditingName(true)}
            title="Click to edit"
            style={{ fontFamily: MONO, fontSize: 10, color: doc.display_name ? TEXT : '#334155', cursor: 'text', padding: '2px 4px', borderRadius: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {doc.display_name || 'Click to set display name…'}
          </div>
        )}
      </div>

      {/* Original filename */}
      <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        Original: {doc.title}
      </div>

      {/* Description (editable) */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b', marginBottom: 2 }}>DESCRIPTION</div>
        {editingDesc ? (
          <textarea
            autoFocus
            value={descVal}
            onChange={e => setDescVal(e.target.value)}
            placeholder="Add a description…"
            rows={2}
            onBlur={saveDesc}
            onKeyDown={e => { if (e.key === 'Escape') { setDescVal(doc.description || ''); setEditingDesc(false) } }}
            style={{ width: '100%', background: '#0d2035', border: `1px solid ${ACCENT}`, color: TEXT, fontFamily: SANS, fontSize: 10, padding: '4px 6px', borderRadius: 3, outline: 'none', resize: 'none', boxSizing: 'border-box' }}
          />
        ) : (
          <div
            onClick={() => setEditingDesc(true)}
            title="Click to edit"
            style={{ fontFamily: SANS, fontSize: 10, color: doc.description ? '#94a3b8' : '#334155', cursor: 'text', padding: '2px 4px', borderRadius: 2, lineHeight: 1.4, minHeight: 20 }}
          >
            {doc.description || 'Click to add description…'}
          </div>
        )}
      </div>

      {/* Badges */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        <Badge bg={color + '25'} color={color}>{(doc.file_type ?? 'file').toUpperCase()}</Badge>
        {doc.revision     && <Badge bg={BORDER2} color={TEXTM}>Rev {doc.revision}</Badge>}
        {(doc.chunk_count ?? 0) > 0 && <Badge bg='#0c2a1a' color='#34d399'>{doc.chunk_count} chunks</Badge>}
        {(doc.field_count ?? 0) > 0 && <Badge bg='#1a1a0a' color='#fbbf24'>{doc.field_count} fields</Badge>}
        {doc.project_name && <span style={{ background: '#0d2035', color: '#38bdf8', border: '1px solid #1e3a5f', fontSize: 9, fontFamily: MONO, fontWeight: 700, padding: '2px 6px', borderRadius: 3, letterSpacing: .5, whiteSpace: 'nowrap', flexShrink: 0 }}>{doc.project_name}</span>}
      </div>

      {/* Indexed time */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 8 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: OK, display: 'inline-block' }} />
        <span style={{ fontFamily: MONO, fontSize: 9, color: '#64748b' }}>indexed {relativeTime(doc.created_at)}</span>
      </div>

      {/* Sample extracted fields */}
      {fields && fields.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontFamily: MONO, fontSize: 8, color: '#64748b', marginBottom: 4, letterSpacing: .5 }}>EXTRACTED FIELDS</div>
          {fields.slice(0, 5).map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 2 }}>
              <span style={{ fontFamily: MONO, fontSize: 9, color: '#94a3b8', flexShrink: 0, width: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.field_name}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 9, color: TEXT, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.field_value}
              </span>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={onDelete}
        style={{ width: '100%', background: '#7f1d1d', border: '1px solid #991b1b', color: '#f87171', fontFamily: MONO, fontSize: 9, padding: '5px 8px', borderRadius: 3, cursor: 'pointer', letterSpacing: .5 }}
      >× REMOVE FROM INDEX</button>
    </div>
  )
}

function IssuesTab({ issues, onClassify }) {
  const [comments, setComments] = useState({})
  if (!issues?.length) return <EmptyState text="No issues detected for this tag." icon="✓" ok />

  return (
    <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {issues.filter(Boolean).map(issue => (
        <IssueCard
          key={issue.id}
          issue={issue}
          comment={comments[issue.id] ?? ''}
          onCommentChange={v => setComments(p => ({ ...p, [issue.id]: v }))}
          onClassify={cls => onClassify(issue.id, cls, comments[issue.id])}
        />
      ))}
    </div>
  )
}

function IssueCard({ issue, comment, onCommentChange, onClassify }) {
  const [open, setOpen] = useState(false)
  const desc = parseIssueDesc(issue.description)
  const sColor = severityColor(issue.severity)

  return (
    <div style={{
      background: PANEL2, border: `1px solid ${BORDER}`,
      borderLeft: `3px solid ${sColor}`,
      borderRadius: 4,
    }}>
      {/* Header row */}
      <div
        onClick={() => setOpen(p => !p)}
        style={{
          padding: '8px 10px', cursor: 'pointer',
          display: 'flex', alignItems: 'flex-start', gap: 7,
        }}
      >
        <Badge bg={sColor + '25'} color={sColor}>{issue.severity?.toUpperCase() ?? 'INFO'}</Badge>
        <span style={{
          fontFamily: SANS, fontSize: 11, color: TEXT, lineHeight: 1.4, flex: 1,
        }}>
          {desc.title ?? issue.description}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: TEXTD, flexShrink: 0 }}>
          {open ? '▴' : '▾'}
        </span>
      </div>

      {/* Expanded detail */}
      {open && (
        <div style={{ padding: '0 10px 10px', borderTop: `1px solid ${BORDER}` }}>
          {desc.detail && (
            <p style={{ fontFamily: SANS, fontSize: 11, color: TEXTM, lineHeight: 1.5, margin: '8px 0' }}>
              {desc.detail}
            </p>
          )}

          {/* Field comparison */}
          {desc.field_name && (
            <div style={{ fontFamily: MONO, fontSize: 10, marginBottom: 8 }}>
              <span style={{ color: TEXTD }}>FIELD: </span>
              <span style={{ color: ACCENT }}>{desc.field_name}</span>
              {desc.value_a && (
                <>
                  <br />
                  <span style={{ color: ERR }}>A: {desc.value_a}</span>
                  {desc.value_b && <span style={{ color: OK }}>  B: {desc.value_b}</span>}
                </>
              )}
            </div>
          )}

          {/* Classify buttons */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
            {[
              { label: 'ERROR',    color: ERR  },
              { label: 'WARNING',  color: WARN },
              { label: 'QUERY',    color: ACCENT },
              { label: 'ACCEPTED', color: OK  },
            ].map(({ label, color }) => (
              <SmallButton key={label} color={color} onClick={() => onClassify(label)} label={label} />
            ))}
          </div>

          {/* Comment input */}
          <textarea
            value={comment}
            onChange={e => onCommentChange(e.target.value)}
            placeholder="Add a comment…"
            rows={2}
            style={{
              width: '100%', background: PANEL,
              border: `1px solid ${BORDER}`,
              borderRadius: 4, padding: '6px 8px',
              color: TEXT, fontFamily: SANS, fontSize: 11,
              resize: 'none', outline: 'none',
            }}
          />
        </div>
      )}
    </div>
  )
}

function WiringTab({ tagId }) {
  const [wiring, setWiring] = useState(null)
  useEffect(() => {
    if (!tagId) return
    api('POST', '/api/wiring/get', { tagId })
      .then(d => setWiring(Array.isArray(d) ? d : []))
      .catch(() => setWiring([]))
  }, [tagId])

  if (!wiring) return <EmptyState text="Loading wiring data…" />
  if (!wiring.length) return <EmptyState text="No wiring records for this tag." />

  return (
    <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {wiring.map((w, i) => (
        <div key={i} style={{
          background: PANEL2, border: `1px solid ${BORDER}`,
          borderRadius: 4, padding: '8px 10px',
          fontFamily: MONO, fontSize: 10,
        }}>
          <div style={{ color: ACCENT, marginBottom: 4 }}>{w.signal_name ?? '—'}</div>
          <div style={{ color: TEXTM, display: 'flex', gap: 4, alignItems: 'center' }}>
            <span>{w.from_terminal ?? '?'}</span>
            <span style={{ color: TEXTD }}>→</span>
            <span>{w.to_terminal ?? '?'}</span>
          </div>
          {w.cable_tag && (
            <div style={{ color: TEXTD, marginTop: 3 }}>Cable: {w.cable_tag}</div>
          )}
        </div>
      ))}
    </div>
  )
}

function HistoryTab({ tagId }) {
  const [history, setHistory] = useState(null)
  useEffect(() => {
    if (!tagId) return
    api('GET', '/api/git/history')
      .then(d => setHistory(Array.isArray(d) ? d : []))
      .catch(() => setHistory([]))
  }, [tagId])

  if (!history) return <EmptyState text="Loading history…" />
  if (!history.length) return <EmptyState text="No history for this tag." />

  return (
    <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {history.map((h, i) => (
        <div key={i} style={{
          background: PANEL2, border: `1px solid ${BORDER}`,
          borderRadius: 4, padding: '8px 10px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <Badge
              bg={h.type === 'note' ? ACCENTD : ERR + '20'}
              color={h.type === 'note' ? ACCENT : ERR}
            >
              {h.type?.toUpperCase() ?? 'ENTRY'}
            </Badge>
            <span style={{ fontFamily: MONO, fontSize: 9, color: TEXTD }}>
              {h.created_at ? new Date(h.created_at).toLocaleDateString() : ''}
            </span>
          </div>
          <p style={{ fontFamily: SANS, fontSize: 11, color: TEXT, lineHeight: 1.4, margin: 0 }}>
            {h.content ?? h.note ?? h.description ?? ''}
          </p>
          {h.author && (
            <div style={{ fontFamily: MONO, fontSize: 9, color: TEXTD, marginTop: 3 }}>
              {h.author}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function EmptyState({ text, icon, ok }) {
  return (
    <div style={{
      padding: '28px 16px', textAlign: 'center',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
    }}>
      <span style={{ fontSize: 20, opacity: .3 }}>{icon ?? '○'}</span>
      <span style={{ fontFamily: MONO, fontSize: 10, color: ok ? OK : TEXTD, lineHeight: 1.6 }}>
        {text}
      </span>
    </div>
  )
}

// ── Setup Wizard ──────────────────────────────────────────────────────────────

function WizardField({ label, value, onChange, type = 'text', placeholder = '' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontFamily: MONO, fontSize: 9, color: TEXTM, letterSpacing: 1 }}>
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          background: PANEL2, border: `1px solid ${BORDER2}`,
          borderRadius: 4, padding: '8px 12px',
          color: TEXT, fontFamily: SANS, fontSize: 13,
          outline: 'none', width: '100%',
        }}
      />
    </div>
  )
}
function ConfigPanel({ onClose, onSaved }) {
  const [cfg, setCfg] = useState({
    engineer_name: '', engineer_email: '', plant_name: '', area: ''
  })
  const [saving, setSaving] = useState(false)
  const [msg,    setMsg]    = useState('')

  useEffect(() => {
    api('GET', '/api/workspace/config').then(data => {
      if (data) setCfg({
        engineer_name:  data.engineer_name  ?? '',
        engineer_email: data.engineer_email ?? '',
        plant_name:     data.plant_name     ?? '',
        area:           data.area           ?? '',
      })
    })
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await api('POST', '/api/workspace/setup', {
        engineerName:  cfg.engineer_name,
        engineerEmail: cfg.engineer_email,
        plantName:     cfg.plant_name,
        area:          cfg.area,
      })
      await api('POST', '/api/workspace/saveConfig')
      setMsg('Saved')
      setTimeout(() => { setMsg(''); onSaved() }, 1200)
    } catch (e) {
      setMsg('Error: ' + e.message)
    }
    setSaving(false)
  }

  const field = (label, key) => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4, letterSpacing: 1 }}>
        {label}
      </div>
      <input
        value={cfg[key]}
        onChange={e => setCfg(p => ({ ...p, [key]: e.target.value }))}
        style={{
          width: '100%', padding: '8px 12px', borderRadius: 6,
          border: '1px solid #cbd5e1', fontSize: 14,
          background: '#f8fafc', color: '#0f172a', boxSizing: 'border-box',
        }}
      />
    </div>
  )

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999,
    }}>
      <div style={{
        background: '#fff', borderRadius: 12, padding: 32, width: 480,
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>Edit Configuration</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#64748b' }}>×</button>
        </div>
        {field('ENGINEER NAME',  'engineer_name')}
        {field('ENGINEER EMAIL', 'engineer_email')}
        {field('PLANT NAME',     'plant_name')}
        {field('AREA / UNIT',    'area')}
        {msg && (
          <div style={{ marginBottom: 12, fontSize: 13, fontWeight: 600,
            color: msg.startsWith('Error') ? '#dc2626' : '#16a34a' }}>
            {msg}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button onClick={onClose} style={{ padding: '8px 20px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#f8fafc', cursor: 'pointer', fontSize: 13 }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving} style={{ padding: '8px 20px', borderRadius: 6, border: 'none', background: '#1d4ed8', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
function SetupWizard({ onComplete }) {
  const [step,          setStep]          = useState(0)
  const [engineerName,  setEngineerName]  = useState('')
  const [engineerEmail, setEngineerEmail] = useState('')
  const [plantName,     setPlantName]     = useState('')
  const [area,          setArea]          = useState('')
  const [apiKey,        setApiKey]        = useState('')
  const [sourcePaths,   setSourcePaths]   = useState([])
  const [submitting,    setSubmitting]    = useState(false)
  const [error,         setError]         = useState('')

  const [folderInput, setFolderInput] = useState('')

  const addFolder = () => {
    const f = folderInput.trim()
    if (f) { setSourcePaths(p => [...p, f]); setFolderInput('') }
  }

  const removeFolder = idx =>
    setSourcePaths(p => p.filter((_, i) => i !== idx))

  const handleSubmit = async () => {
    if (!engineerName.trim()) { setError('Engineer name is required.'); return }
    if (!plantName.trim())    { setError('Plant name is required.');    return }
    setError('')
    setSubmitting(true)
    try {
      await api('POST', '/api/workspace/setup', {
        engineer_name:  engineerName.trim(),
        engineer_email: engineerEmail.trim() || 'engram@local',
        plant_name:     plantName.trim(),
        area:           area.trim() || 'general',
        claude_api_key: apiKey.trim(),
        source_paths:   sourcePaths,
      })
      onComplete()
    } catch (err) {
      setError(err.message ?? 'Setup failed — check console.')
      setSubmitting(false)
    }
  }

  const STEPS = [
    { title: 'ENGINEER IDENTITY', subtitle: 'Your name and email for document authorship and git commits.' },
    { title: 'PLANT & AREA',      subtitle: 'Plant and process area context for document paths and queries.' },
    { title: 'AI CONFIGURATION',  subtitle: 'Optional Claude API key for AI-assisted document analysis.' },
    { title: 'SOURCE FOLDERS',    subtitle: 'Add folders containing your existing engineering documents.' },
  ]

  const canNext = () => {
    if (step === 0) return engineerName.trim().length > 0
    if (step === 1) return plantName.trim().length > 0
    return true
  }

  return (
    <div style={{
      height: '100vh', background: BG,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: 520, background: PANEL,
        border: `1px solid ${BORDER}`, borderRadius: 10,
        overflow: 'hidden',
        animation: 'engram-fadein .3s ease-out',
      }}>
        {/* Wizard header */}
        <div style={{
          padding: '20px 28px 16px',
          borderBottom: `1px solid ${BORDER}`,
          background: PANEL2,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
            <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: ACCENT, letterSpacing: 3 }}>
              ENGRAM
            </span>
            <span style={{ fontFamily: MONO, fontSize: 8, color: TEXTD, letterSpacing: 2 }}>
              SETUP
            </span>
          </div>

          {/* Step indicators */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {STEPS.map((_, i) => (
              <div key={i} style={{
                flex: 1, height: 3, borderRadius: 2,
                background: i <= step ? ACCENT : BORDER2,
                transition: 'background .3s',
              }} />
            ))}
          </div>

          <div style={{ fontFamily: MONO, fontSize: 11, color: ACCENT, letterSpacing: 1 }}>
            {STEPS[step].title}
          </div>
          <div style={{ fontFamily: SANS, fontSize: 11, color: TEXTM, marginTop: 3 }}>
            {STEPS[step].subtitle}
          </div>
        </div>

        {/* Step content */}
        <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {step === 0 && (
            <>
              <WizardField label="ENGINEER NAME *" value={engineerName} onChange={setEngineerName} placeholder="e.g. J. Smith" />
              <WizardField label="ENGINEER EMAIL"  value={engineerEmail} onChange={setEngineerEmail} type="email" placeholder="e.g. jsmith@company.com" />
            </>
          )}
          {step === 1 && (
            <>
              <WizardField label="PLANT NAME *" value={plantName} onChange={setPlantName} placeholder="e.g. Refinery Unit 3" />
              <WizardField label="AREA / UNIT"  value={area}      onChange={setArea}      placeholder="e.g. crude_distillation" />
            </>
          )}
          {step === 2 && (
            <WizardField
              label="CLAUDE API KEY (OPTIONAL)"
              value={apiKey}
              onChange={setApiKey}
              type="password"
              placeholder="sk-ant-..."
            />
          )}
          {step === 3 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 140, overflowY: 'auto' }}>
                {sourcePaths.length === 0 && (
                  <div style={{ fontFamily: MONO, fontSize: 10, color: TEXTD, padding: '8px 0' }}>
                    No folders added — you can add them later.
                  </div>
                )}
                {sourcePaths.map((p, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    background: PANEL2, border: `1px solid ${BORDER}`,
                    borderRadius: 4, padding: '6px 10px',
                  }}>
                    <span style={{ fontFamily: MONO, fontSize: 10, color: TEXTM, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p}
                    </span>
                    <button onClick={() => removeFolder(i)} style={{
                      background: 'transparent', border: 'none',
                      color: ERR, cursor: 'pointer', fontSize: 14, padding: 0,
                    }}>×</button>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={folderInput}
                  onChange={e => setFolderInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addFolder()}
                  placeholder="Server folder path…"
                  style={{
                    flex: 1, background: PANEL2, border: `1px solid ${BORDER2}`,
                    borderRadius: 4, padding: '8px 10px',
                    color: TEXT, fontFamily: MONO, fontSize: 10, outline: 'none',
                  }}
                />
                <button
                  onClick={addFolder}
                  style={{
                    background: BORDER, border: `1px solid ${BORDER2}`,
                    color: TEXTM, fontFamily: MONO, fontSize: 10,
                    padding: '8px 14px', borderRadius: 4, cursor: 'pointer',
                  }}
                >
                  + Add
                </button>
              </div>
            </div>
          )}

          {error && (
            <div style={{ fontFamily: MONO, fontSize: 10, color: ERR }}>
              {error}
            </div>
          )}
        </div>

        {/* Navigation */}
        <div style={{
          padding: '14px 28px',
          borderTop: `1px solid ${BORDER}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <button
            onClick={() => setStep(s => Math.max(0, s - 1))}
            disabled={step === 0}
            style={{
              background: 'transparent',
              border: `1px solid ${step === 0 ? BORDER : BORDER2}`,
              color: step === 0 ? TEXTD : TEXTM,
              fontFamily: MONO, fontSize: 10,
              padding: '7px 18px', borderRadius: 4, cursor: step === 0 ? 'default' : 'pointer',
            }}
          >
            BACK
          </button>

          {step < STEPS.length - 1 ? (
            <button
              onClick={() => canNext() && setStep(s => s + 1)}
              disabled={!canNext()}
              style={{
                background: canNext() ? ACCENTD : BORDER,
                border: `1px solid ${canNext() ? ACCENT + '60' : BORDER}`,
                color: canNext() ? ACCENT : TEXTD,
                fontFamily: MONO, fontSize: 10, fontWeight: 700,
                padding: '7px 22px', borderRadius: 4,
                cursor: canNext() ? 'pointer' : 'default',
                letterSpacing: .5,
              }}
            >
              NEXT
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={submitting}
              style={{
                background: submitting ? BORDER : ACCENTD,
                border: `1px solid ${submitting ? BORDER : ACCENT + '60'}`,
                color: submitting ? TEXTD : ACCENT,
                fontFamily: MONO, fontSize: 10, fontWeight: 700,
                padding: '7px 22px', borderRadius: 4,
                cursor: submitting ? 'default' : 'pointer',
                letterSpacing: .5,
                display: 'flex', alignItems: 'center', gap: 8,
              }}
            >
              {submitting && <Spinner />}
              {submitting ? 'INITIALISING…' : 'LAUNCH ENGRAM'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Root App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [setupDone,     setSetupDone]     = useState(null)  // null = checking
  const [activeTag,     setActiveTag]     = useState(null)
  const [messages,      setMessages]      = useState([{
    role: 'assistant',
    text: 'Select a tag from the file tree to begin.\n\nI can help you verify field values across documents, identify conflicts, trace wiring, and check calibration status.\n\nAll answers are grounded in your indexed documents.',
    citations: [],
  }])
  const [isLoading,     setIsLoading]     = useState(false)
  const [tags,          setTags]          = useState([])
  const [docs,          setDocs]          = useState([])
  const [issues,        setIssues]        = useState([])
  const [activeTab,     setActiveTab]     = useState('DOCS')
  const [inputText,     setInputText]     = useState('')
  const [engineerName,  setEngineerName]  = useState('')
  const [allDocs,       setAllDocs]       = useState([])
  const [projects,      setProjects]      = useState(['Default'])
  const [currentProject, setCurrentProject] = useState('Default')
  const [standards,     setStandards]     = useState([])
  const [showConfig,    setShowConfig]    = useState(false)

  // ── Check if workspace is initialised ────────────────────────────────────
  useEffect(() => {
    api('GET', '/api/workspace/config')
      .then(cfg => {
        setSetupDone(cfg?.workspace_initialised === '1')
        if (cfg?.engineer_name) setEngineerName(cfg.engineer_name)
      })
      .catch(() => setSetupDone(false))
  }, [])

  // ── Load tags on mount ───────────────────────────────────────────────────
  const loadTags = useCallback(() => {
    api('GET', '/api/tags/list')
      .then(data => {
        const arr = Array.isArray(data) ? data : (data?.ok ? data.tags ?? [] : [])
        setTags(arr)
      })
      .catch(err => console.error('[App] listTags:', err))
  }, [])

  // ── Load standards ───────────────────────────────────────────────────────
  const loadStandards = useCallback(() => {
    api('GET', '/api/standards/list')
      .then(res => { if (res?.ok) setStandards(res.standards ?? []) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!setupDone) return
    loadTags()
    loadStandards()
    api('GET', '/api/workspace/config')
      .then(cfg => { if (cfg?.engineer_name) setEngineerName(cfg.engineer_name) })
      .catch(() => {})
  }, [setupDone, loadTags, loadStandards])

  // ── Load all workspace docs + projects (for DOCS tab) ────────────────────
  const loadAllDocs = useCallback(() => {
    api('GET', '/api/docs/list')
      .then(res => { if (res?.ok) setAllDocs(res.docs ?? []) })
      .catch(() => {})
    api('GET', '/api/projects/list')
      .then(res => { if (res?.ok) setProjects(res.projects ?? ['Default']) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!setupDone) return
    loadAllDocs()
    api('GET', '/api/projects/getCurrent')
      .then(name => { if (name) setCurrentProject(name) })
      .catch(() => {})
    const id = setInterval(loadAllDocs, 10_000)
    return () => clearInterval(id)
  }, [setupDone, loadAllDocs])

  // ── Index progress: rely on setInterval polling (no push events in web mode)
  // loadAllDocs already runs every 10 s in the effect above; no extra listener needed.

  // ── Load docs + issues when tag changes ──────────────────────────────────
  useEffect(() => {
    if (!activeTag) { setDocs([]); setIssues([]); return }

    Promise.allSettled([
      api('POST', '/api/docs/get',   { tagId: activeTag.id }),
      api('POST', '/api/issues/get', { tagId: activeTag.id }),
    ]).then(([docsRes, issuesRes]) => {
      setDocs(docsRes.status === 'fulfilled' ? (docsRes.value ?? []) : [])
      setIssues(issuesRes.status === 'fulfilled' ? (issuesRes.value ?? []) : [])
    })

    setActiveTab('DOCS')
  }, [activeTag?.id])

  // ── Derived stats ────────────────────────────────────────────────────────
  const totalDocs   = tags.reduce((s, t) => s + (t.docCount   ?? 0), 0)
  const totalIssues = tags.reduce((s, t) => s + (t.issueCount ?? 0), 0)
  const totalErrors = tags.reduce((s, t) => s + (t.errorCount ?? 0), 0)

  // ── Send message ─────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = inputText.trim()
    if (!text || isLoading) return

    setInputText('')
    setMessages(prev => [...prev, { role: 'user', text, citations: [] }])
    setIsLoading(true)

    try {
      const prefix = activeTag ? `[Tag: ${activeTag.name}] ` : ''
      const resp   = await api('POST', '/api/query/send', { message: prefix + text })
      const responseText = typeof resp === 'string'
        ? resp
        : resp?.response
          ?? resp?.text
          ?? resp?.answer
          ?? (resp?.ok === false ? 'Error: ' + resp?.error : null)
          ?? 'No response received.'
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: responseText,
        citations: resp?.citations ?? [],
      }])
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: `⚠ ${err.message}`,
        citations: [],
      }])
    } finally {
      setIsLoading(false)
    }
  }, [inputText, isLoading, activeTag])

  const handleKeyDown = useCallback(e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }, [handleSend])

  // ── Diff actions ─────────────────────────────────────────────────────────
  const handleAcceptDiff = useCallback(diff => {
    api('POST', '/api/stage/change', { tagId: activeTag?.id, field: diff.field, oldVal: diff.oldVal, newVal: diff.newVal })
      .catch(console.error)
    setMessages(prev => [...prev, {
      role: 'assistant',
      text: `Change accepted — staged: ${diff.field} → ${diff.newVal}`,
      citations: [],
    }])
  }, [activeTag])

  const handleRejectDiff = useCallback(diff => {
    setMessages(prev => [...prev, {
      role: 'assistant',
      text: `Change rejected — ${diff.field} remains ${diff.oldVal}`,
      citations: [],
    }])
  }, [])

  // ── Issue classification ──────────────────────────────────────────────────
  const handleClassifyIssue = useCallback((issueId, classification, comment) => {
    api('POST', '/api/issues/update', { id: issueId, classification, comment })
      .catch(console.error)
  }, [])

  // ── Workspace actions ────────────────────────────────────────────────────
  const docFileInputRef = useRef(null)

  // Trigger the hidden file input — the actual upload happens in handleDocFileChange
  const handleAddDocs = useCallback(() => {
    docFileInputRef.current?.click()
  }, [])

  const handleDocFileChange = useCallback(async (e) => {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return
    e.target.value = '' // reset so the same file can be re-selected

    const formData = new FormData()
    files.forEach(f => formData.append('files', f))
    if (activeTag?.id) formData.append('tagId', String(activeTag.id))

    try {
      await fetch('/api/docs/add', {
        method: 'POST',
        headers: { 'x-engram-token': TOKEN },
        body: formData,
      })
    } catch (err) {
      console.error('Add documents error:', err)
    }
    loadAllDocs()
  }, [activeTag, loadAllDocs])

  const handleDeleteDoc = useCallback(async (docId) => {
    await api('POST', '/api/docs/delete', { docId }).catch(console.error)
    loadAllDocs()
  }, [loadAllDocs])

  const handleRenameDoc = useCallback(async (docId, displayName, description) => {
    await api('POST', '/api/docs/rename', { docId, displayName, description }).catch(console.error)
    setAllDocs(prev => prev.map(d =>
      d.id === docId ? { ...d, display_name: displayName || null, description: description || null } : d
    ))
  }, [])

  const handleSetProject = useCallback((name) => {
    setCurrentProject(name)
    api('POST', '/api/projects/setCurrent', { name }).catch(console.error)
  }, [])

  const handleNewProject = useCallback((name) => {
    api('POST', '/api/projects/create', { name })
      .then(() => {
        setProjects(prev => [...new Set([...prev, name])].sort(
          (a, b) => a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b)
        ))
        setCurrentProject(name)
        api('POST', '/api/projects/setCurrent', { name }).catch(console.error)
      })
      .catch(console.error)
  }, [])

  const handleCreateTag = useCallback(async (data) => {
    await api('POST', '/api/tags/create', data).catch(console.error)
    loadTags()
  }, [loadTags])

  const handleUpdateTag = useCallback(async (data) => {
    await api('POST', '/api/tags/update', data).catch(console.error)
    setTags(prev => prev.map(t =>
      (t.tag_id || t.name) === data.tag_id ? { ...t, ...data } : t
    ))
  }, [])

  const handleDeleteTag = useCallback(async (tagId) => {
    await api('POST', '/api/tags/delete', { tagId }).catch(console.error)
    setTags(prev => prev.filter(t => (t.tag_id || t.name) !== tagId))
    if ((activeTag?.tag_id || activeTag?.name) === tagId) setActiveTag(null)
  }, [activeTag])

  const handleCopyTag = useCallback(async (tagId, newId) => {
    await api('POST', '/api/tags/copy', { tagId, newTagId: newId }).catch(console.error)
    loadTags()
  }, [loadTags])

  const handleReindex = useCallback(() => {
    api('POST', '/api/index/reindexAll').catch(console.error)
    setMessages(prev => [...prev, {
      role: 'assistant',
      text: 'Re-index job queued. Documents will be re-processed in the background.',
      citations: [],
    }])
  }, [])

  // ── Render ────────────────────────────────────────────────────────────────
  // Still checking setup status — show blank screen to avoid flicker
  if (showConfig) {
    return (
      <>
        <style>{STYLE_TAG}</style>
        <ConfigPanel
          onClose={() => setShowConfig(false)}
          onSaved={() => {
            setShowConfig(false)
            api('GET', '/api/workspace/config').then(cfg => {
              if (cfg?.engineer_name) setEngineerName(cfg.engineer_name)
            })
          }}
        />
      </>
    )
  }
  if (setupDone === null) {
    return <><style>{STYLE_TAG}</style><div style={{ height: '100vh', background: BG }} /></>
  }

  // First launch — show wizard
  if (setupDone === false) {
    return (
      <>
        <style>{STYLE_TAG}</style>
        <SetupWizard onComplete={() => {
          setSetupDone(true)
          loadTags()
        }} />
      </>
    )
  }

  return (
    <>
      <style>{STYLE_TAG}</style>

      {/* Hidden file input for document uploads — triggered by handleAddDocs */}
      <input
        ref={docFileInputRef}
        type="file"
        multiple
        accept=".pdf,.docx,.doc,.xlsx,.xls,.txt"
        style={{ display: 'none' }}
        onChange={handleDocFileChange}
      />

      <div style={{
        display: 'flex', flexDirection: 'column',
        height: '100vh', overflow: 'hidden',
        background: BG, color: TEXT, fontFamily: SANS,
      }}>
        <TopBar
          engineerName={engineerName}
          totalDocs={totalDocs}
          totalIssues={totalIssues}
          totalErrors={totalErrors}
          onEditConfig={() => setShowConfig(prev => !prev)}
        />

        {/* Three-panel body */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <LeftPanel
            tags={tags}
            activeTag={activeTag}
            onSelectTag={tag => setActiveTag(tag)}
            onCreateTag={handleCreateTag}
            onUpdateTag={handleUpdateTag}
            onDeleteTag={handleDeleteTag}
            onCopyTag={handleCopyTag}
            onAddDocs={handleAddDocs}
            onReindex={handleReindex}
          />

          <CentrePanel
            activeTag={activeTag}
            messages={messages}
            isLoading={isLoading}
            inputText={inputText}
            onInputChange={setInputText}
            onSend={handleSend}
            onKeyDown={handleKeyDown}
            onAcceptDiff={handleAcceptDiff}
            onRejectDiff={handleRejectDiff}
          />

          <RightPanel
            activeTag={activeTag}
            allDocs={allDocs}
            projects={projects}
            currentProject={currentProject}
            issues={issues}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onClassifyIssue={handleClassifyIssue}
            onDeleteDoc={handleDeleteDoc}
            onReindexAll={handleReindex}
            onSetProject={handleSetProject}
            onNewProject={handleNewProject}
            onRenameDoc={handleRenameDoc}
            standards={standards}
            onStandardsRefresh={loadStandards}
          />
        </div>
      </div>
    </>
  )
}
