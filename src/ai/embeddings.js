const OLLAMA_BASE = 'http://localhost:11434';

export const EMBEDDING_MODEL = 'nomic-embed-text';
export const EMBEDDING_DIMS  = 768;

const ZERO_VECTOR = Object.freeze(new Array(EMBEDDING_DIMS).fill(0));

/**
 * Returns true if the Ollama daemon is reachable.
 */
export async function checkOllamaAvailable() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Generate an embedding vector for the given text.
 * Returns a float[] of length EMBEDDING_DIMS.
 * On failure, logs a warning and returns a zero vector instead of throwing.
 *
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function generateEmbedding(text) {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`Ollama responded with HTTP ${res.status}`);
    }

    const { embedding } = await res.json();

    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error('Ollama returned an empty or invalid embedding');
    }

    return embedding;
  } catch (err) {
    console.warn(`[embeddings] generateEmbedding failed — returning zero vector. Reason: ${err.message}`);
    return ZERO_VECTOR.slice(); // mutable copy
  }
}
