/**
 * One gzip member (RFC 1952) for a single saved file, made with the platform's
 * CompressionStream, which browsers and Node both provide. Null where the
 * platform has none or compression fails, so a caller can offer the
 * uncompressed file instead.
 */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Response(bytes.slice()).body!.pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}
