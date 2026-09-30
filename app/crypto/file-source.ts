/** Markdown source bounds, measured before encryption and after opening legacy Files. */
export const FILE_SOURCE_LIMIT = 262_144;
export const FILE_SOURCE_FEEDBACK = 235_930;
export function fileSourceBytes(source: string): number {
  return new TextEncoder().encode(source).byteLength;
}
