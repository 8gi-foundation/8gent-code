async function drain<T>(source: ReadableStream<T> | AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  if (Symbol.asyncIterator in source) {
    for await (const chunk of source as AsyncIterable<T>) {
      chunks.push(chunk);
    }
  } else {
    const reader = (source as ReadableStream<T>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return chunks;
}

export async function collectStream<T>(
  stream: ReadableStream<T> | AsyncIterable<T>,
): Promise<T[]> {
  return drain(stream);
}

export async function collectString(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<string> {
  const chunks = await drain(stream);
  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c, { stream: true })).join("") +
    decoder.decode();
}

export async function collectBuffer(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks = await drain(stream);
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
