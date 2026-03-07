import { generateEmbedding } from './embeddings.js';

/**
 * Creates or loads a vectra LocalIndex at the given folder path.
 *
 * @param {string} indexPath  Folder path for the index (created if absent).
 * @returns {Promise<import('vectra').LocalIndex>}
 */
export async function initVectorStore(indexPath) {
  const fs = await import('fs');
  const { LocalIndex } = await import('vectra');

  if (!fs.existsSync(indexPath)) {
    fs.mkdirSync(indexPath, { recursive: true });
  }

  const store = new LocalIndex(indexPath);

  if (!(await store.isIndexCreated())) {
    await store.createIndex();
  }

  return store;
}

/**
 * Embed `text` and upsert it into the store.
 *
 * The vectra item ID is `"${id}-${metadata.chunk_index ?? 0}"`, allowing the
 * same document to contribute multiple chunks while sharing the same `doc_id`
 * in metadata.
 *
 * Metadata stored per item:
 *   doc_id, tag_id, doc_type, filename, revision, area, discipline, chunk_index
 *
 * @param {LocalIndex} store
 * @param {string|number} id          Document ID (mapped to metadata.doc_id).
 * @param {string}        text        Text to embed.
 * @param {{
 *   tag_id?:      string|number,
 *   doc_type?:    string,
 *   filename?:    string,
 *   revision?:    string,
 *   area?:        string,
 *   discipline?:  string,
 *   chunk_index?: number,
 * }} metadata
 */
export async function addDocument(store, id, text, metadata = {}) {
  const chunkIndex = metadata.chunk_index ?? 0;
  const itemId     = `${id}-${chunkIndex}`;

  const vector = await generateEmbedding(text);

  await store.upsertItem({
    id: itemId,
    vector,
    metadata: {
      text:        metadata.text        ?? null,
      doc_id:      id,
      tag_id:      metadata.tag_id      ?? null,
      doc_type:    metadata.doc_type    ?? null,
      filename:    metadata.filename    ?? null,
      revision:    metadata.revision    ?? null,
      area:        metadata.area        ?? null,
      discipline:  metadata.discipline  ?? null,
      chunk_index: chunkIndex,
    },
  });
}

/**
 * Semantic search against the store.
 *
 * @param {LocalIndex}    store
 * @param {string}        queryText
 * @param {number}        [k=5]       Number of results to return.
 * @returns {Promise<Array<{ id: string, score: number, metadata: object }>>}
 */
export async function searchDocuments(store, queryText, k = 5) {
  const vector  = await generateEmbedding(queryText);
  const results = await store.queryItems(vector, queryText, k);

  return results.map(({ item, score }) => ({
    id:       item.id,
    score,
    text:     item.metadata?.text ?? '',
    metadata: item.metadata,
  }));
}

/**
 * Delete all index items belonging to a document (matched by metadata.doc_id).
 *
 * Uses a single beginUpdate/endUpdate cycle so all deletes are one disk write.
 *
 * @param {LocalIndex}    store
 * @param {string|number} id   The doc_id whose items should be removed.
 */
export async function deleteDocument(store, id) {
  const all     = await store.listItems();
  const targets = all.filter(item => item.metadata?.doc_id == id); // loose == handles int/string

  if (targets.length === 0) return;

  await store.beginUpdate();
  try {
    for (const item of targets) {
      await store.deleteItem(item.id);
    }
    await store.endUpdate();
  } catch (err) {
    store.cancelUpdate();
    throw err;
  }
}

/**
 * No-op: vectra auto-persists to disk after every upsert/delete.
 * Provided for API symmetry so callers can await persistStore(store)
 * if a future backend ever requires an explicit flush.
 *
 * @param {LocalIndex} store
 */
export async function persistStore(store) { // eslint-disable-line no-unused-vars
  // vectra's LocalIndex writes index.json on every endUpdate() call,
  // which is invoked automatically by upsertItem() and deleteItem().
  // Nothing to do here.
}
