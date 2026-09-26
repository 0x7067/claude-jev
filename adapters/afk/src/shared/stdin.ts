export async function readStdinJson<T = unknown>(): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else chunks.push(Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  // SAFETY: T is the documented hook event shape; each caller owns decoding its fields.
  return JSON.parse(raw) as T;
}
