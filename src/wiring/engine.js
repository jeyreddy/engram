// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split a free-text answer into two parts, trying common delimiters in order:
 *   " and "  →  "T1 and T2"
 *   ","      →  "JB-100-F, North pipe rack"
 *   "/"      →  "T1/T2"
 *
 * @param {string} answer
 * @returns {[string, string|null]}
 */
function splitPair(answer) {
  const s = answer.trim();

  const andIdx = s.toLowerCase().indexOf(' and ');
  if (andIdx !== -1) {
    return [s.slice(0, andIdx).trim(), s.slice(andIdx + 5).trim()];
  }

  const commaIdx = s.indexOf(',');
  if (commaIdx !== -1) {
    return [s.slice(0, commaIdx).trim(), s.slice(commaIdx + 1).trim()];
  }

  const slashIdx = s.indexOf('/');
  if (slashIdx !== -1) {
    return [s.slice(0, slashIdx).trim(), s.slice(slashIdx + 1).trim()];
  }

  return [s, null];
}

/** Format a pos/neg terminal pair as "T1(+)/T2(-)". Returns null if both absent. */
function fmtPair(pos, neg) {
  if (!pos && !neg) return null;
  const parts = [];
  if (pos) parts.push(`${pos}(+)`);
  if (neg) parts.push(`${neg}(-)`);
  return parts.join('/');
}

/** True when the engineer typed nothing (skip for optional steps). */
const isSkip = a => !a || a.trim() === '' || a.trim().toLowerCase() === 'skip';

// ---------------------------------------------------------------------------
// Step configuration
// Each entry drives one conversational exchange.
// step index 0 = session.step 1.
// ---------------------------------------------------------------------------

const STEPS = [
  // 1 — signal type
  {
    ask: ({ tagId }) =>
      `What is the signal type for ${tagId}?\n` +
      `(e.g. 4-20mA HART 2-wire, 24VDC discrete, PT100 RTD)`,
    parse: ans => ({ signal_type: ans.trim() }),
    validate: ans => ans.trim() ? null : 'Signal type is required.',
  },

  // 2 — field instrument terminals
  {
    ask: () =>
      'What are the field instrument terminals?\n' +
      '(e.g. T1 and T2, or + and -)',
    parse: ans => {
      const [pos, neg] = splitPair(ans);
      return { field_terminal_pos: pos || null, field_terminal_neg: neg || null };
    },
    validate: ans => splitPair(ans)[0] ? null : 'At least one terminal reference is required.',
  },

  // 3 — field cable reference
  {
    ask: () =>
      'What is the cable or wire reference from the instrument to the junction box?',
    parse: ans => ({ field_cable_ref: ans.trim() }),
    validate: ans => ans.trim() ? null : 'Cable reference is required.',
  },

  // 4 — JB reference + location
  {
    ask: () =>
      'What is the junction box reference and location?\n' +
      '(e.g. JB-100-F, North pipe rack elevation +6.5m)',
    parse: ans => {
      const [ref, loc] = splitPair(ans);
      return { jb_ref: ref || null, jb_location: loc || null };
    },
    validate: ans => splitPair(ans)[0] ? null : 'Junction box reference is required.',
  },

  // 5 — JB terminals
  {
    ask: ({ tagId }) =>
      `What are the junction box terminal numbers for ${tagId}?\n` +
      `(e.g. T14 and T15)`,
    parse: ans => {
      const [pos, neg] = splitPair(ans);
      return { jb_terminal_pos: pos || null, jb_terminal_neg: neg || null };
    },
    validate: ans => splitPair(ans)[0] ? null : 'At least one JB terminal is required.',
  },

  // 6 — onwards cable (JB → marshalling panel)
  {
    ask: () =>
      'What is the cable reference from the junction box to the marshalling panel?',
    parse: ans => ({ onwards_cable_ref: ans.trim() }),
    validate: ans => ans.trim() ? null : 'Cable reference is required.',
  },

  // 7 — panel reference + terminal block
  {
    ask: () =>
      'What is the marshalling panel reference and terminal block?\n' +
      '(e.g. MRP-C11, TB-04)',
    parse: ans => {
      const [ref, tb] = splitPair(ans);
      return { panel_ref: ref || null, panel_tb_ref: tb || null };
    },
    validate: ans => splitPair(ans)[0] ? null : 'Panel reference is required.',
  },

  // 8 — panel terminals
  {
    ask: () =>
      'What are the panel terminal numbers?\n' +
      '(e.g. T28 and T29)',
    parse: ans => {
      const [pos, neg] = splitPair(ans);
      return { panel_terminal_pos: pos || null, panel_terminal_neg: neg || null };
    },
    validate: ans => splitPair(ans)[0] ? null : 'At least one panel terminal is required.',
  },

  // 9 — DCS card + channel
  {
    ask: () =>
      'What is the DCS card reference and channel number?\n' +
      '(e.g. AIC-01, Channel 4)',
    parse: ans => {
      const [ref, raw] = splitPair(ans);
      // Strip "Channel " / "Ch." prefix from the channel part
      const channel = raw ? raw.replace(/^(?:channel|ch)\.?\s*/i, '').trim() : null;
      return { dcs_card_ref: ref || null, dcs_channel: channel || null };
    },
    validate: ans => splitPair(ans)[0] ? null : 'DCS card reference is required.',
  },

  // 10 — DCS cabinet (optional)
  {
    optional: true,
    ask: () =>
      'What cabinet is the DCS card in?\n' +
      '(press Enter to skip)',
    parse: ans => ({ dcs_cabinet: isSkip(ans) ? null : ans.trim() }),
    validate: () => null,
  },

  // 11 — free notes (optional)
  {
    optional: true,
    ask: () =>
      'Any additional notes?\n' +
      '(press Enter to skip)',
    parse: ans => ({ wiring_notes: isSkip(ans) ? null : ans.trim() }),
    validate: () => null,
  },

  // 12 — confirmation
  {
    confirm: true,
    ask: () => null,   // question is built dynamically from summary
    parse: ans => ({ _confirm: ans.trim().toLowerCase() }),
    validate: () => null,
  },
];

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(session) {
  const d = session.data;
  const lines = [
    `Wiring summary for ${session.tagId}`,
    '─'.repeat(40),
    `  Signal type:      ${d.signal_type ?? '—'}`,
    `  Field terminals:  ${fmtPair(d.field_terminal_pos, d.field_terminal_neg) ?? '—'}`,
    `  Field cable:      ${d.field_cable_ref ?? '—'}`,
    `  Junction box:     ${d.jb_ref ?? '—'}${d.jb_location ? ` (${d.jb_location})` : ''}`,
    `  JB terminals:     ${fmtPair(d.jb_terminal_pos, d.jb_terminal_neg) ?? '—'}`,
    `  Panel cable:      ${d.onwards_cable_ref ?? '—'}`,
    `  Panel:            ${[d.panel_ref, d.panel_tb_ref].filter(Boolean).join(' ') || '—'}`,
    `  Panel terminals:  ${fmtPair(d.panel_terminal_pos, d.panel_terminal_neg) ?? '—'}`,
    `  DCS card:         ${d.dcs_card_ref ?? '—'}${d.dcs_channel ? ` Ch.${d.dcs_channel}` : ''}`,
  ];
  if (d.dcs_cabinet)  lines.push(`  DCS cabinet:      ${d.dcs_cabinet}`);
  if (d.wiring_notes) lines.push(`  Notes:            ${d.wiring_notes}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API — session
// ---------------------------------------------------------------------------

/**
 * Start a new wiring entry session for a tag.
 *
 * @param {string|number} tagId
 * @returns {{ session: object, question: string }}
 */
export function startWiringSession(tagId) {
  const session = { tagId, step: 1, data: {}, complete: false };
  const question = STEPS[0].ask(session);
  return { session, question };
}

/**
 * Advance the wiring entry session by one step.
 *
 * @param {{ tagId, step, data, complete }} session
 * @param {string} answer   Engineer's free-text answer.
 * @returns {{
 *   session:   object,
 *   question?: string,
 *   complete:  boolean,
 *   summary?:  string,
 * }}
 */
export function nextWiringStep(session, answer) {
  const stepCfg = STEPS[session.step - 1];

  // Guard: already complete or out of bounds
  if (!stepCfg || session.complete) {
    return { session: { ...session, complete: true }, complete: true, summary: buildSummary(session) };
  }

  // ── Confirm step ─────────────────────────────────────────────────────────
  if (stepCfg.confirm) {
    const reply = answer.trim().toLowerCase();
    if (reply === 'yes' || reply === 'y') {
      const done = { ...session, complete: true };
      return { session: done, complete: true, summary: buildSummary(done) };
    }
    // "no" or anything else: restart
    const fresh = { tagId: session.tagId, step: 1, data: {}, complete: false };
    return {
      session:  fresh,
      question: `OK, let's start over.\n\n${STEPS[0].ask(fresh)}`,
      complete: false,
    };
  }

  // ── Validate ──────────────────────────────────────────────────────────────
  if (!stepCfg.optional) {
    const err = stepCfg.validate(answer);
    if (err) {
      return {
        session,
        question: `⚠ ${err}\n\n${stepCfg.ask(session)}`,
        complete: false,
      };
    }
  }

  // ── Apply answer to session data ──────────────────────────────────────────
  const newData    = { ...session.data, ...stepCfg.parse(answer) };
  const nextStep   = session.step + 1;
  const nextCfg    = STEPS[nextStep - 1];
  const newSession = { ...session, step: nextStep, data: newData };

  if (!nextCfg) {
    // All steps exhausted without a confirm step — treat as complete
    return { session: { ...newSession, complete: true }, complete: true, summary: buildSummary(newSession) };
  }

  // ── Build next question ───────────────────────────────────────────────────
  let question;
  if (nextCfg.confirm) {
    question = `${buildSummary(newSession)}\n\nDoes this look correct? (yes / no)`;
  } else {
    question = nextCfg.ask(newSession);
  }

  return { session: newSession, question, complete: false };
}

// ---------------------------------------------------------------------------
// Public API — persistence
// ---------------------------------------------------------------------------

/**
 * Save (insert or update) a completed wiring session to the database.
 *
 * Creates:
 *   • cables row for field_cable_ref (field → JB)
 *   • cables row for onwards_cable_ref (JB → panel)
 *   • Two cable_cores per cable (+ and − conductors)
 *   • One wiring_records row with the full chain encoded in `notes` JSON
 *
 * The `notes` JSON is the canonical store for jb_ref, panel_ref, dcs_card_ref,
 * dcs_channel etc., which have no explicit columns in the current schema.
 * All cross-map and DCS-trace queries use json_extract() against this blob.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ tagId, data: object }} session
 * @returns {{ wiringId: number, tagId: string|number }}
 */
export function saveWiringRecord(db, session) {
  const { tagId, data: d } = session;

  const run = db.transaction(() => {

    // ── Upsert helper for cables ────────────────────────────────────────────
    const upsertCable = (ref, description, from, to) => {
      if (!ref) return null;
      return db.prepare(`
        INSERT INTO cables (tag_number, description, cable_type, from_location, to_location)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tag_number) DO UPDATE SET
          description   = excluded.description,
          from_location = excluded.from_location,
          to_location   = excluded.to_location,
          updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        RETURNING id
      `).get(ref, description, d.signal_type ?? null, from, to)?.id ?? null;
    };

    // ── Field cable (instrument → JB) ───────────────────────────────────────
    const fieldCableId = upsertCable(
      d.field_cable_ref,
      `${d.signal_type ?? 'Signal'} — field cable`,
      `Field ${tagId}`,
      d.jb_ref ?? 'JB',
    );

    // ── Onwards cable (JB → panel) ───────────────────────────────────────────
    const onwardsCableId = upsertCable(
      d.onwards_cable_ref,
      `${d.signal_type ?? 'Signal'} — panel cable`,
      d.jb_ref ?? 'JB',
      d.panel_ref ?? 'Panel',
    );

    // ── Cable cores ──────────────────────────────────────────────────────────
    const insertCore = db.prepare(`
      INSERT OR IGNORE INTO cable_cores
        (cable_id, core_number, signal_name, from_terminal, to_terminal)
      VALUES (?, ?, ?, ?, ?)
    `);

    if (fieldCableId) {
      if (d.field_terminal_pos)
        insertCore.run(fieldCableId, '1', `${tagId} +`, d.field_terminal_pos, d.jb_terminal_pos ?? null);
      if (d.field_terminal_neg)
        insertCore.run(fieldCableId, '2', `${tagId} −`, d.field_terminal_neg, d.jb_terminal_neg ?? null);
    }

    if (onwardsCableId) {
      if (d.jb_terminal_pos)
        insertCore.run(onwardsCableId, '1', `${tagId} +`, d.jb_terminal_pos, d.panel_terminal_pos ?? null);
      if (d.jb_terminal_neg)
        insertCore.run(onwardsCableId, '2', `${tagId} −`, d.jb_terminal_neg, d.panel_terminal_neg ?? null);
    }

    // ── Notes JSON (full chain, used by all query functions) ─────────────────
    const notes = JSON.stringify({
      tag_id:             tagId,
      signal_type:        d.signal_type        ?? null,
      field_terminal_pos: d.field_terminal_pos ?? null,
      field_terminal_neg: d.field_terminal_neg ?? null,
      field_cable_ref:    d.field_cable_ref    ?? null,
      jb_ref:             d.jb_ref             ?? null,
      jb_location:        d.jb_location        ?? null,
      jb_terminal_pos:    d.jb_terminal_pos    ?? null,
      jb_terminal_neg:    d.jb_terminal_neg    ?? null,
      onwards_cable_ref:  d.onwards_cable_ref  ?? null,
      panel_ref:          d.panel_ref          ?? null,
      panel_tb_ref:       d.panel_tb_ref       ?? null,
      panel_terminal_pos: d.panel_terminal_pos ?? null,
      panel_terminal_neg: d.panel_terminal_neg ?? null,
      dcs_card_ref:       d.dcs_card_ref       ?? null,
      dcs_channel:        d.dcs_channel        ?? null,
      dcs_cabinet:        d.dcs_cabinet        ?? null,
      wiring_notes:       d.wiring_notes       ?? null,
    });

    // ── Upsert wiring_records row ────────────────────────────────────────────
    const fromTerminal = fmtPair(d.field_terminal_pos, d.field_terminal_neg);
    const toTerminal   = d.dcs_card_ref
      ? `${d.dcs_card_ref}${d.dcs_channel ? ` Ch.${d.dcs_channel}` : ''}`
      : null;

    const existing = db.prepare(`
      SELECT id FROM wiring_records
      WHERE json_extract(notes, '$.tag_id') = ?
      LIMIT 1
    `).get(tagId);

    let wiringId;
    if (existing) {
      db.prepare(`
        UPDATE wiring_records SET
          cable_id      = ?,
          signal_name   = ?,
          from_terminal = ?,
          to_terminal   = ?,
          notes         = ?,
          updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(fieldCableId, d.signal_type ?? null, fromTerminal, toTerminal, notes, existing.id);
      wiringId = existing.id;
    } else {
      const result = db.prepare(`
        INSERT INTO wiring_records (cable_id, signal_name, from_terminal, to_terminal, notes)
        VALUES (?, ?, ?, ?, ?)
      `).run(fieldCableId, d.signal_type ?? null, fromTerminal, toTerminal, notes);
      wiringId = result.lastInsertRowid;
    }

    return { wiringId, tagId };
  });

  return run();
}

// ---------------------------------------------------------------------------
// Public API — queries
// ---------------------------------------------------------------------------

/**
 * Return the full wiring chain for a tag as a readable string.
 *
 * Format:
 *   "Field FT-1001 T1(+)/T2(-) → Cable W-1021-A →
 *    JB-100-F T14(+)/T15(-) → Cable C-1021 →
 *    MRP-C11 TB-04 T28(+)/T29(-) → AIC-01 Ch.4"
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} tagId
 * @returns {string|null}
 */
export function getWiringChain(db, tagId) {
  const row = db.prepare(`
    SELECT notes FROM wiring_records
    WHERE  json_extract(notes, '$.tag_id') = ?
    ORDER  BY id DESC LIMIT 1
  `).get(tagId);

  if (!row) return null;

  let d;
  try { d = JSON.parse(row.notes); } catch { return null; }

  const segments = [];

  // Field instrument
  const fieldTerms = fmtPair(d.field_terminal_pos, d.field_terminal_neg);
  segments.push(`Field ${d.tag_id ?? tagId}${fieldTerms ? ` ${fieldTerms}` : ''}`);

  // Field cable
  if (d.field_cable_ref) segments.push(`Cable ${d.field_cable_ref}`);

  // Junction box
  const jbTerms = fmtPair(d.jb_terminal_pos, d.jb_terminal_neg);
  if (d.jb_ref) segments.push(`${d.jb_ref}${jbTerms ? ` ${jbTerms}` : ''}`);

  // Onwards cable
  if (d.onwards_cable_ref) segments.push(`Cable ${d.onwards_cable_ref}`);

  // Marshalling panel
  const panelTerms = fmtPair(d.panel_terminal_pos, d.panel_terminal_neg);
  if (d.panel_ref) {
    segments.push(
      [d.panel_ref, d.panel_tb_ref, panelTerms].filter(Boolean).join(' ')
    );
  }

  // DCS card
  if (d.dcs_card_ref) {
    segments.push(`${d.dcs_card_ref}${d.dcs_channel ? ` Ch.${d.dcs_channel}` : ''}`);
  }

  return segments.join(' → ');
}

/**
 * Return all tags that terminate in a given junction box.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} jbRef   Exact JB reference (e.g. "JB-100-F").
 * @returns {Array<{
 *   tagId:           string|number,
 *   description:     string,
 *   jb_terminal_pos: string|null,
 *   jb_terminal_neg: string|null,
 *   cable_ref:       string|null,
 *   signal_type:     string|null,
 * }>}
 */
export function getJBCrossmap(db, jbRef) {
  const rows = db.prepare(`
    SELECT
      json_extract(wr.notes, '$.tag_id')            AS raw_tag_id,
      t.id                                           AS tag_id,
      t.name                                         AS tag_name,
      json_extract(wr.notes, '$.jb_terminal_pos')   AS jb_terminal_pos,
      json_extract(wr.notes, '$.jb_terminal_neg')   AS jb_terminal_neg,
      json_extract(wr.notes, '$.field_cable_ref')   AS cable_ref,
      json_extract(wr.notes, '$.signal_type')        AS signal_type
    FROM  wiring_records wr
    LEFT  JOIN tags t ON CAST(t.id AS TEXT) = CAST(json_extract(wr.notes, '$.tag_id') AS TEXT)
    WHERE json_extract(wr.notes, '$.jb_ref') = ?
    ORDER BY COALESCE(t.name, CAST(json_extract(wr.notes, '$.tag_id') AS TEXT))
  `).all(jbRef);

  return rows.map(r => ({
    tagId:           r.tag_id   ?? r.raw_tag_id,
    description:     r.tag_name ?? String(r.raw_tag_id ?? ''),
    jb_terminal_pos: r.jb_terminal_pos,
    jb_terminal_neg: r.jb_terminal_neg,
    cable_ref:       r.cable_ref,
    signal_type:     r.signal_type,
  }));
}

/**
 * Find all tags wired to a DCS card, optionally filtered by channel.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string}       dcsCardRef   e.g. "AIC-01"
 * @param {string|null}  [channel]    e.g. "4"  (omit to get all channels)
 * @returns {Array<{
 *   tagId:       string|number,
 *   description: string,
 *   dcs_channel: string|null,
 *   panel_ref:   string|null,
 *   jb_ref:      string|null,
 * }>}
 */
export function traceFromDCS(db, dcsCardRef, channel = null) {
  const hasChannel = channel != null && String(channel).trim() !== '';

  const sql = `
    SELECT
      json_extract(wr.notes, '$.tag_id')       AS raw_tag_id,
      t.id                                      AS tag_id,
      t.name                                    AS tag_name,
      json_extract(wr.notes, '$.dcs_channel')  AS dcs_channel,
      json_extract(wr.notes, '$.panel_ref')    AS panel_ref,
      json_extract(wr.notes, '$.jb_ref')       AS jb_ref
    FROM  wiring_records wr
    LEFT  JOIN tags t ON CAST(t.id AS TEXT) = CAST(json_extract(wr.notes, '$.tag_id') AS TEXT)
    WHERE json_extract(wr.notes, '$.dcs_card_ref') = ?
      ${hasChannel ? 'AND json_extract(wr.notes, \'$.dcs_channel\') = ?' : ''}
    ORDER BY COALESCE(t.name, CAST(json_extract(wr.notes, '$.tag_id') AS TEXT))
  `;

  const params = hasChannel ? [dcsCardRef, String(channel)] : [dcsCardRef];
  const rows   = db.prepare(sql).all(...params);

  return rows.map(r => ({
    tagId:       r.tag_id   ?? r.raw_tag_id,
    description: r.tag_name ?? String(r.raw_tag_id ?? ''),
    dcs_channel: r.dcs_channel,
    panel_ref:   r.panel_ref,
    jb_ref:      r.jb_ref,
  }));
}

// ---------------------------------------------------------------------------
// Public API — cable management
// ---------------------------------------------------------------------------

/**
 * Insert (or upsert) a cable into the cables table.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string}      cableRef       Unique cable tag number (e.g. "W-1021-A")
 * @param {string}      spec           Cable spec / type description
 * @param {string}      fromLocation   Origin location
 * @param {string}      toLocation     Destination location
 * @param {string|null} [route]        Physical cable route description
 * @param {string|null} [screenEarth]  Screen / earth arrangement
 * @returns {number}  Cable ID (lastInsertRowid)
 */
export function addCable(db, cableRef, spec, fromLocation, toLocation, route = null, screenEarth = null) {
  const descParts = [spec];
  if (route)       descParts.push(`Route: ${route}`);
  if (screenEarth) descParts.push(`Screen: ${screenEarth}`);
  const description = descParts.join(' | ');

  const row = db.prepare(`
    INSERT INTO cables (tag_number, description, cable_type, from_location, to_location)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tag_number) DO UPDATE SET
      description   = excluded.description,
      cable_type    = excluded.cable_type,
      from_location = excluded.from_location,
      to_location   = excluded.to_location,
      updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    RETURNING id
  `).get(cableRef, description, spec, fromLocation, toLocation);

  return row.id;
}

/**
 * Insert a cable core record.
 * The cable is looked up by its `tag_number` (cableRef).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string}           cableRef        Cable tag number
 * @param {string}           coreNumber      Core identifier (e.g. "1", "A")
 * @param {string}           colour          Wire colour
 * @param {string|number|null} tagId         Tag this core carries
 * @param {string|null}      signalPolarity  Polarity label (e.g. "+", "−", "RTN")
 * @returns {number}  Core ID (lastInsertRowid)
 */
export function addCableCore(db, cableRef, coreNumber, colour, tagId, signalPolarity) {
  const cable = db.prepare('SELECT id FROM cables WHERE tag_number = ?').get(cableRef);
  if (!cable) throw new Error(`Cable "${cableRef}" not found. Create it with addCable() first.`);

  const signalName = [tagId, signalPolarity].filter(Boolean).join(' ');

  const result = db.prepare(`
    INSERT INTO cable_cores (cable_id, core_number, signal_name, wire_color)
    VALUES (?, ?, ?, ?)
  `).run(cable.id, coreNumber, signalName || null, colour || null);

  return result.lastInsertRowid;
}
