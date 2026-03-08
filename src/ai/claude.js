//
// src/ai/claude.js — Claude API integration
//
// SYSTEM PROMPT ARCHITECTURE:
//   The prompt is assembled from three parts in queryWithContext():
//     1. SYSTEM_CORE     — static persona and grounding rules (never invent values)
//     2. Context line    — plant/discipline/user identity from workspace_config
//     3. systemExtra     — optional addendum passed by the caller; used by the
//                          query:send handler to inject the standards_registry
//                          list ("APPLICABLE STANDARDS & CODES: …")
//
// CONTEXT INJECTION:
//   Document context is prepended to the USER message (not the system prompt)
//   as a structured block:  [filename | doc_type | Rev X]\n<content>
//   This keeps the system prompt stable (better cache reuse) and lets Claude
//   cite sources naturally in its response.
//
// MODEL:
//   claude-sonnet-4-6 balances speed and quality for document analysis tasks.
//   max_tokens is set to 2048 — sufficient for detailed field-by-field answers.
//

import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../db/workspace.js';

export const CLAUDE_MODEL = 'claude-sonnet-4-6';

// Core system instructions.  Keep this stable — changing it invalidates any
// prompt caching benefit on the Anthropic API side.
const SYSTEM_CORE = `You are ENGRAM, a plant document integrity assistant.
Answer only from the provided document context.
Always cite the source document and field.
If information is not in the context say so explicitly.
Never invent values.
When context includes STANDARD/POLICY documents, apply those requirements to your analysis and flag any non-conformances.`;

/**
 * Returns true if a Claude API key is configured and the SDK can be instantiated.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean}
 */
export function checkClaudeAvailable(db) {
  try {
    const key = getConfig(db, 'claude_api_key');
    return typeof key === 'string' && key.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Send a message to Claude with injected document context.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} userMessage
 * @param {Array<{
 *   text?:     string,
 *   content?:  string,
 *   metadata?: { filename?: string, doc_type?: string, revision?: string, [k: string]: any }
 * }>} contextChunks   Pre-fetched document chunks from vectra or MCP tools.
 * @param {string} [systemExtra]  Optional extra system-prompt text appended after the core.
 * @returns {Promise<string>}  The assistant's response text.
 */
export async function queryWithContext(db, userMessage, contextChunks, systemExtra) {
  const apiKey = getConfig(db, 'claude_api_key');
  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      'Claude API key not configured. ' +
      'Set workspace_config key "claude_api_key" to your Anthropic API key.'
    );
  }

  // -------------------------------------------------------------------------
  // Build system prompt
  // -------------------------------------------------------------------------
  const engineerName = getConfig(db, 'engineer_name') ?? 'Engineer';
  const discipline   = getConfig(db, 'discipline')    ?? 'Instrumentation';
  const plant        = getConfig(db, 'plant_name')    ?? 'Plant';

  const systemParts = [
    SYSTEM_CORE,
    `Context: ${plant} | Discipline: ${discipline} | User: ${engineerName}`,
  ];
  if (systemExtra) systemParts.push(systemExtra);
  const system = systemParts.join('\n\n');

  // -------------------------------------------------------------------------
  // Build user message — inject document context blocks
  // -------------------------------------------------------------------------
  let fullMessage = userMessage;

  if (contextChunks && contextChunks.length > 0) {
    console.log('[claude] context being sent:', contextChunks.map(c => (c.text ?? c.metadata?.text ?? '').slice(0, 100)).join('\n'));
    const contextBlock = contextChunks
      .map((chunk, i) => {
        const meta    = chunk.metadata ?? {};
        const srcParts = [
          meta.filename,
          meta.doc_type,
          meta.revision && `Rev ${meta.revision}`,
        ].filter(Boolean);
        const src     = srcParts.length ? srcParts.join(' | ') : `Source ${i + 1}`;
        const body    = (chunk.text ?? chunk.content ?? '').trim();
        return `[${src}]\n${body}`;
      })
      .join('\n\n---\n\n');

    fullMessage = `Document Context:\n${contextBlock}\n\n---\n\nQuestion: ${userMessage}`;
  }

  // -------------------------------------------------------------------------
  // Call Claude
  // -------------------------------------------------------------------------
  const client   = new Anthropic({ apiKey: apiKey.trim() });
  const response = await client.messages.create({
    model:      CLAUDE_MODEL,
    max_tokens: 2048,
    system,
    messages:   [{ role: 'user', content: fullMessage }],
  });

  const block = response.content.find(b => b.type === 'text');
  return block?.text ?? '';
}
