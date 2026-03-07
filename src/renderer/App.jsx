import { useState, useEffect, useRef, useCallback } from 'react'

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

function TopBar({ engineerName, totalDocs, totalIssues, totalErrors }) {
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

// ── Left Panel ────────────────────────────────────────────────────────────────

function LeftPanel({ tags, activeTag, onSelectTag, onAddDocs, onReindex }) {
  const [collapsed, setCollapsed] = useState({})
  const groups = groupTags(tags)

  const toggleGroup = key => setCollapsed(p => ({ ...p, [key]: !p[key] }))

  return (
    <div style={{
      width: 240, flexShrink: 0,
      background: PANEL, borderRight: `1px solid ${BORDER}`,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 12px 8px',
        borderBottom: `1px solid ${BORDER}`,
      }}>
        <span style={{ fontFamily: MONO, fontSize: 9, color: TEXTD, letterSpacing: 2 }}>
          WORKSPACE
        </span>
      </div>

      {/* Tree */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
        {groups.length === 0 && (
          <div style={{ padding: '20px 8px', textAlign: 'center', color: TEXTD, fontFamily: MONO, fontSize: 10 }}>
            No tags indexed
          </div>
        )}
        {groups.map(([key, groupTags]) => (
          <div key={key} style={{ marginBottom: 4 }}>
            {/* Group header */}
            <button
              onClick={() => toggleGroup(key)}
              style={{
                width: '100%', background: 'transparent', border: 'none',
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 8px', cursor: 'pointer', borderRadius: 3,
              }}
            >
              <span style={{
                fontFamily: MONO, fontSize: 8, color: TEXTD,
                letterSpacing: 1.5, userSelect: 'none',
              }}>
                {collapsed[key] ? '▸' : '▾'} {key}
              </span>
              <span style={{
                fontFamily: MONO, fontSize: 8,
                background: BORDER2, color: TEXTM,
                borderRadius: 8, padding: '0 5px',
              }}>
                {groupTags.length}
              </span>
            </button>

            {/* Tag items */}
            {!collapsed[key] && (
              <div style={{ paddingLeft: 8 }}>
                {groupTags.map(tag => (
                  <TagItem
                    key={tag.id}
                    tag={tag}
                    isActive={activeTag?.id === tag.id}
                    onClick={() => onSelectTag(tag)}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Bottom actions */}
      <div style={{
        padding: 10, borderTop: `1px solid ${BORDER}`,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <ActionButton icon="＋" label="Add Documents"      onClick={onAddDocs}  />
        <ActionButton icon="↺" label="Re-index Workspace"  onClick={onReindex} dim />
      </div>
    </div>
  )
}

function TagItem({ tag, isActive, onClick }) {
  const hasErrors = (tag.errorCount ?? 0) > 0
  const issueCount = tag.issueCount ?? 0
  const coverage   = tag.coverage ?? 0

  return (
    <div
      onClick={onClick}
      style={{
        padding: '6px 8px', marginBottom: 2,
        background: isActive ? ACCENTD : 'transparent',
        border: `1px solid ${isActive ? ACCENT + '30' : 'transparent'}`,
        borderRadius: 4, cursor: 'pointer',
        transition: 'background .15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {hasErrors && <PulsingDot />}
        <span style={{
          fontFamily: MONO, fontSize: 11,
          color: isActive ? ACCENT : TEXT, flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {tag.name}
        </span>
        {issueCount > 0 && (
          <span style={{
            background: ERR + '25', color: ERR,
            fontFamily: MONO, fontSize: 9,
            padding: '1px 5px', borderRadius: 8,
          }}>
            {issueCount}
          </span>
        )}
      </div>
      <CoverageBar pct={coverage} />
    </div>
  )
}

function ActionButton({ icon, label, onClick, dim }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? (dim ? BORDER2 : ACCENTD) : BORDER,
        border: `1px solid ${hover ? (dim ? BORDER2 : ACCENT + '40') : BORDER}`,
        color: hover ? (dim ? TEXTM : ACCENT) : TEXTM,
        fontFamily: MONO, fontSize: 10,
        padding: '6px 10px', borderRadius: 4,
        cursor: 'pointer', textAlign: 'left',
        display: 'flex', alignItems: 'center', gap: 7,
        transition: 'all .15s',
      }}
    >
      <span style={{ fontSize: 12 }}>{icon}</span>
      {label}
    </button>
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

const TABS = ['DOCUMENTS', 'ISSUES', 'WIRING', 'HISTORY']

function RightPanel({ activeTag, docs, issues, activeTab, onTabChange, onClassifyIssue }) {
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
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            style={{
              flex: 1, background: 'transparent',
              border: 'none', borderBottom: `2px solid ${activeTab === tab ? ACCENT : 'transparent'}`,
              color: activeTab === tab ? ACCENT : TEXTM,
              fontFamily: MONO, fontSize: 8, fontWeight: 700,
              padding: '10px 0', cursor: 'pointer',
              letterSpacing: .8, transition: 'color .15s',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!activeTag ? (
          <div style={{
            padding: 24, textAlign: 'center',
            color: TEXTD, fontFamily: MONO, fontSize: 10, lineHeight: 1.8,
          }}>
            Select a tag to view context
          </div>
        ) : (
          <>
            {activeTab === 'DOCUMENTS' && <DocumentsTab docs={docs} />}
            {activeTab === 'ISSUES'    && <IssuesTab issues={issues} onClassify={onClassifyIssue} />}
            {activeTab === 'WIRING'    && <WiringTab tagId={activeTag.id} />}
            {activeTab === 'HISTORY'   && <HistoryTab tagId={activeTag.id} />}
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
      {docs.map(doc => (
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

function IssuesTab({ issues, onClassify }) {
  const [comments, setComments] = useState({})
  if (!issues?.length) return <EmptyState text="No issues detected for this tag." icon="✓" ok />

  return (
    <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {issues.map(issue => (
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
    window.engram?.getWiring?.(tagId)
      .then(d => setWiring(d ?? []))
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
    window.engram?.getHistory?.(tagId)
      .then(d => setHistory(d ?? []))
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

  const addFolder = async () => {
    const folder = await window.engram?.openFolder?.()
    if (folder) setSourcePaths(p => [...p, folder])
  }

  const removeFolder = idx =>
    setSourcePaths(p => p.filter((_, i) => i !== idx))

  const handleSubmit = async () => {
    if (!engineerName.trim()) { setError('Engineer name is required.'); return }
    if (!plantName.trim())    { setError('Plant name is required.');    return }
    setError('')
    setSubmitting(true)
    try {
      await window.engram?.setupWorkspace?.({
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
              <button
                onClick={addFolder}
                style={{
                  background: BORDER, border: `1px solid ${BORDER2}`,
                  color: TEXTM, fontFamily: MONO, fontSize: 10,
                  padding: '8px 14px', borderRadius: 4, cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                + Add Folder
              </button>
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
  const [activeTab,     setActiveTab]     = useState('DOCUMENTS')
  const [inputText,     setInputText]     = useState('')
  const [engineerName,  setEngineerName]  = useState('')

  // ── Check if workspace is initialised ────────────────────────────────────
  useEffect(() => {
    window.engram?.getWorkspaceConfig?.()
      .then(cfg => {
        setSetupDone(cfg?.workspace_initialised === '1')
        if (cfg?.engineer_name) setEngineerName(cfg.engineer_name)
      })
      .catch(() => setSetupDone(false))
  }, [])

  // ── Load tags on mount ───────────────────────────────────────────────────
  useEffect(() => {
    if (!setupDone) return
    window.engram?.getTags?.()
      .then(data => setTags(Array.isArray(data) ? data : []))
      .catch(err => console.error('[App] getTags:', err))

    window.engram?.getWorkspaceConfig?.()
      .then(cfg => { if (cfg?.engineer_name) setEngineerName(cfg.engineer_name) })
      .catch(() => {})
  }, [setupDone])

  // ── Load docs + issues when tag changes ──────────────────────────────────
  useEffect(() => {
    if (!activeTag) { setDocs([]); setIssues([]); return }

    Promise.allSettled([
      window.engram?.getDocs?.(activeTag.id),
      window.engram?.getIssues?.(activeTag.id),
    ]).then(([docsRes, issuesRes]) => {
      setDocs(docsRes.status === 'fulfilled' ? (docsRes.value ?? []) : [])
      setIssues(issuesRes.status === 'fulfilled' ? (issuesRes.value ?? []) : [])
    })

    setActiveTab('DOCUMENTS')
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
      const resp   = await window.engram?.query?.(prefix + text)
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: resp ?? 'No response received.',
        citations: [],
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
    window.engram?.stageChange?.(activeTag?.id, diff.field, diff.oldVal, diff.newVal)
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
    window.engram?.classifyIssue?.(issueId, classification, comment)
      .catch(console.error)
  }, [])

  // ── Workspace actions ────────────────────────────────────────────────────
  const handleAddDocs = useCallback(async () => {
    console.log("Add Documents clicked")
    console.log("window.engram:", window.engram)
    console.log("openFiles:", window.engram?.openFiles)

    try {
      const files = await window.engram.openFiles()
      console.log("Files returned:", files)

      if (!files || files.length === 0) {
        console.log("No files selected")
        return
      }

      for (const filePath of files) {
        console.log("Adding file:", filePath)
        const result = await window.engram.addDoc({
          filePath,
          tagId: activeTag?.id
        })
        console.log("Add result:", result)
      }
    } catch (err) {
      console.error("Add documents error:", err)
    }
  }, [activeTag])

  const handleReindex = useCallback(() => {
    window.engram?.reindex?.().catch(console.error)
    setMessages(prev => [...prev, {
      role: 'assistant',
      text: 'Re-index job queued. Documents will be re-processed in the background.',
      citations: [],
    }])
  }, [])

  // ── Render ────────────────────────────────────────────────────────────────
  // Still checking setup status — show blank screen to avoid flicker
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
          window.engram?.getTags?.()
            .then(data => setTags(Array.isArray(data) ? data : []))
            .catch(() => {})
        }} />
      </>
    )
  }

  return (
    <>
      <style>{STYLE_TAG}</style>

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
        />

        {/* Three-panel body */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <LeftPanel
            tags={tags}
            activeTag={activeTag}
            onSelectTag={tag => setActiveTag(tag)}
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
            docs={docs}
            issues={issues}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onClassifyIssue={handleClassifyIssue}
          />
        </div>
      </div>
    </>
  )
}
