import git from 'isomorphic-git';
import fs from 'node:fs';
import { writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { join, dirname } from 'path';
import { getConfig } from '../db/workspace.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise an OS path to forward-slash posix form for all git internals.
 * isomorphic-git requires posix paths on all platforms.
 */
function toGitPath(p) {
  return p.split('\\').join('/');
}

/** Returns true if the path exists on disk (non-throwing). */
async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Parse the structured metadata lines from an ENGRAM commit body.
 * Lines are expected in the form "Key:     value".
 */
function parseBodyMetadata(body = '') {
  const meta = {};
  for (const line of body.split('\n')) {
    const m = /^([A-Za-z ]+):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1].trim().toLowerCase().replace(/\s+/g, '_');
    meta[key] = m[2].trim();
  }
  return meta;
}

/**
 * Build the structured ENGRAM commit message from metadata.
 */
function buildCommitMessage(metadata) {
  const {
    tagId, action,
    fieldName, oldValue, newValue,
    source, issueRef, note,
  } = metadata;

  // First line: [TAG-ID] ACTION: brief description
  const tag   = tagId   ? `[${tagId}] `  : '';
  const act   = action  ? `${action}: `  : '';
  let brief   = 'document change';
  if (fieldName && oldValue !== undefined && newValue !== undefined) {
    brief = `${fieldName} ${oldValue} → ${newValue}`;
  } else if (fieldName) {
    brief = `update ${fieldName}`;
  }
  const subject = `${tag}${act}${brief}`;

  // Body: only emit lines where value is present
  const bodyLines = [];
  if (fieldName  != null) bodyLines.push(`Field:     ${fieldName}`);
  if (oldValue   != null) bodyLines.push(`Old value: ${oldValue}`);
  if (newValue   != null) bodyLines.push(`New value: ${newValue}`);
  if (source     != null) bodyLines.push(`Source:    ${source}`);
  if (issueRef   != null) bodyLines.push(`Issue ref: ${issueRef}`);
  if (note       != null) bodyLines.push(`Note:      ${note}`);

  return bodyLines.length > 0
    ? `${subject}\n\n${bodyLines.join('\n')}`
    : subject;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise a git repository at repoPath (no-op if already a repo).
 * Sets user.name and user.email from workspace_config if db is provided.
 *
 * @param {string} repoPath
 * @param {import('better-sqlite3').Database} [db]
 * @returns {Promise<{ repoPath: string, isNew: boolean }>}
 */
export async function initRepo(repoPath, db) {
  const isNew = !(await pathExists(join(repoPath, '.git')));

  if (isNew) {
    await git.init({ fs, dir: repoPath, defaultBranch: 'main' });
  }

  // Configure user identity from workspace_config (fall back to safe defaults)
  const name  = (db && getConfig(db, 'engineer_name'))  || 'ENGRAM';
  const email = (db && getConfig(db, 'engineer_email')) || 'engram@local';

  await git.setConfig({ fs, dir: repoPath, path: 'user.name',  value: name  });
  await git.setConfig({ fs, dir: repoPath, path: 'user.email', value: email });

  return { repoPath, isNew };
}

/**
 * Stage a single file (relative posix path within the repo).
 *
 * @param {string} repoPath
 * @param {string} filePath  Path relative to repoPath, forward slashes.
 * @returns {Promise<void>}
 */
export async function stageFile(repoPath, filePath) {
  await git.add({ fs, dir: repoPath, filepath: toGitPath(filePath) });
}

/**
 * Stage all changed files in the repo then create a structured commit.
 *
 * @param {string} repoPath
 * @param {string} message  Ignored in favour of the auto-built message when
 *                          metadata is supplied; kept as explicit override for
 *                          programmatic callers.
 * @param {{
 *   tagId:       string|number,
 *   action:      string,
 *   fieldName?:  string,
 *   oldValue?:   string,
 *   newValue?:   string,
 *   source?:     string,
 *   issueRef?:   string,
 *   note?:       string,
 *   authorName:  string,
 *   authorEmail: string,
 * }} metadata
 * @returns {Promise<{ commitHash: string, timestamp: string }>}
 */
export async function commitChange(repoPath, message, metadata) {
  // ── Stage all changes ────────────────────────────────────────────────────
  const matrix = await git.statusMatrix({ fs, dir: repoPath });

  // Files to add: workdir status 2 = different from HEAD (modified or new)
  const toAdd = matrix
    .filter(([, , workdir]) => workdir === 2)
    .map(([filepath]) => toGitPath(filepath));

  // Files to remove: present in HEAD (1) but absent from workdir (0)
  const toRemove = matrix
    .filter(([, head, workdir]) => head === 1 && workdir === 0)
    .map(([filepath]) => toGitPath(filepath));

  for (const filepath of toAdd)    await git.add   ({ fs, dir: repoPath, filepath });
  for (const filepath of toRemove) await git.remove({ fs, dir: repoPath, filepath });

  // ── Commit ───────────────────────────────────────────────────────────────
  const commitMessage = metadata ? buildCommitMessage(metadata) : message;
  const author = {
    name:  metadata?.authorName  || 'ENGRAM',
    email: metadata?.authorEmail || 'engram@local',
  };

  const commitHash = await git.commit({
    fs,
    dir:     repoPath,
    message: commitMessage,
    author,
    committer: author,
  });

  const timestamp = new Date().toISOString();
  return { commitHash, timestamp };
}

/**
 * Read the git log for the whole repo, or scoped to a specific file.
 *
 * @param {string}  repoPath
 * @param {string}  [filePath]  Posix-relative path to filter history by file.
 * @param {number}  [limit=50]
 * @returns {Promise<Array<{
 *   hash:      string,
 *   shortHash: string,
 *   message:   string,
 *   author:    string,
 *   timestamp: string,
 *   metadata:  object,
 * }>>}
 */
export async function getHistory(repoPath, filePath, limit = 50) {
  const logOpts = { fs, dir: repoPath, depth: limit };
  if (filePath) logOpts.filepath = toGitPath(filePath);

  let entries;
  try {
    entries = await git.log(logOpts);
  } catch (err) {
    // Repo has no commits yet
    if (err.code === 'NotFoundError' || err.message?.includes('Could not find')) return [];
    throw err;
  }

  return entries.map(({ oid, commit }) => {
    const rawMessage = commit.message ?? '';
    // Split into subject (first line) and body (everything after blank line)
    const [subject, , ...bodyLines] = rawMessage.split('\n');
    const body = bodyLines.join('\n');

    return {
      hash:      oid,
      shortHash: oid.slice(0, 7),
      message:   subject.trim(),
      author:    `${commit.author.name} <${commit.author.email}>`,
      timestamp: new Date(commit.author.timestamp * 1000).toISOString(),
      metadata:  parseBodyMetadata(body),
    };
  });
}

/**
 * List the files changed in a specific commit (vs its first parent).
 * For the initial commit, returns all files tracked in that commit.
 *
 * @param {string} repoPath
 * @param {string} commitHash
 * @returns {Promise<string[]>}  Posix-relative file paths.
 */
export async function getFilesChanged(repoPath, commitHash) {
  const { commit } = await git.readCommit({ fs, dir: repoPath, oid: commitHash });
  const parentOid = commit.parent[0];

  // Initial commit: every file in the tree is "new"
  if (!parentOid) {
    return git.listFiles({ fs, dir: repoPath, ref: commitHash });
  }

  const A = git.TREE({ ref: parentOid });
  const B = git.TREE({ ref: commitHash });

  const changed = await git.walk({
    fs,
    dir:   repoPath,
    trees: [A, B],
    map:   async (filepath, [a, b]) => {
      if (filepath === '.') return;                             // skip root entry
      const aType = await a?.type();
      const bType = await b?.type();
      if (aType === 'tree' || bType === 'tree') return;        // skip directories

      const aOid = await a?.oid();
      const bOid = await b?.oid();
      if (aOid !== bOid) return filepath;                      // changed / added / deleted
    },
  });

  return changed.filter(Boolean);
}

/**
 * Create a new revert commit that undoes the changes introduced by commitHash.
 * Does NOT rewrite history — appends a new commit.
 *
 * @param {string} repoPath
 * @param {string} commitHash   Full SHA of the commit to revert.
 * @param {string} authorName
 * @param {string} authorEmail
 * @returns {Promise<{ revertHash: string, timestamp: string }>}
 */
export async function revertCommit(repoPath, commitHash, authorName, authorEmail) {
  const { commit } = await git.readCommit({ fs, dir: repoPath, oid: commitHash });
  const parentOid  = commit.parent[0];

  if (!parentOid) {
    throw new Error(`Cannot revert the initial commit (${commitHash.slice(0, 7)})`);
  }

  // Find every file that differed between parent and the reverted commit
  const changedFiles = await getFilesChanged(repoPath, commitHash);

  for (const filepath of changedFiles) {
    const absPath = join(repoPath, filepath.split('/').join(process.platform === 'win32' ? '\\' : '/'));

    try {
      // Restore the parent's version of the file
      const { blob } = await git.readBlob({
        fs,
        dir:      repoPath,
        oid:      parentOid,
        filepath: toGitPath(filepath),
      });

      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, blob);
      await git.add({ fs, dir: repoPath, filepath: toGitPath(filepath) });

    } catch (err) {
      if (err.code === 'NotFoundError' || err.message?.includes('Could not find')) {
        // File was added in the reverted commit — remove it
        try { await unlink(absPath); } catch { /* already gone */ }
        await git.remove({ fs, dir: repoPath, filepath: toGitPath(filepath) });
      } else {
        throw err;
      }
    }
  }

  const timestamp = new Date().toISOString();
  const message   = [
    `[REVERT] Revert ${commitHash.slice(0, 7)}`,
    '',
    `Note: reverted by ${authorName} on ${timestamp}`,
  ].join('\n');

  const author = { name: authorName, email: authorEmail };

  const revertHash = await git.commit({
    fs,
    dir:       repoPath,
    message,
    author,
    committer: author,
  });

  return { revertHash, timestamp };
}
