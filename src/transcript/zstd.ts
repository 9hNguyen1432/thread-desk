import zlib from 'node:zlib';
import { decompress } from 'fzstd';

type NativeZstd = (buf: Buffer) => Buffer;

/** Node gained built-in zstd in 22.15; older versions fall back to a pure JS decoder. */
export function decompressZstd(buf: Buffer): Buffer {
  const native = (zlib as unknown as { zstdDecompressSync?: NativeZstd }).zstdDecompressSync;
  if (native) return native(buf);
  return Buffer.from(decompress(buf));
}
