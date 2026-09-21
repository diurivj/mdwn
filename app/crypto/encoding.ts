export type ByteSource = Uint8Array | ArrayBuffer | ArrayBufferView;

export function toBytes(value: ByteSource): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));

  return Uint8Array.from(
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
  );
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** Constant-time comparison for equal-length byte strings. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ByteWriter {
  private readonly parts: Uint8Array[] = [];

  writeBytes(value: Uint8Array): this {
    this.parts.push(new Uint8Array(value));
    return this;
  }

  writeU8(value: number): this {
    assertUnsignedInteger(value, 0xff, "u8");
    return this.writeBytes(Uint8Array.of(value));
  }

  writeU16(value: number): this {
    assertUnsignedInteger(value, 0xffff, "u16");
    return this.writeBytes(
      Uint8Array.of((value >>> 8) & 0xff, value & 0xff),
    );
  }

  writeU32(value: number): this {
    assertUnsignedInteger(value, 0xffffffff, "u32");
    return this.writeBytes(
      Uint8Array.of(
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
      ),
    );
  }

  writeU64(value: number | bigint): this {
    const normalized = typeof value === "bigint" ? value : BigInt(value);
    if (normalized < 0n || normalized > 0xffff_ffff_ffff_ffffn) {
      throw new RangeError("u64 is outside its unsigned range");
    }

    const result = new Uint8Array(8);
    let remaining = normalized;
    for (let index = 7; index >= 0; index--) {
      result[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    return this.writeBytes(result);
  }

  writeLengthPrefixedBytes(value: Uint8Array): this {
    this.writeU16(value.byteLength);
    return this.writeBytes(value);
  }

  writeLengthPrefixedString(value: string): this {
    return this.writeLengthPrefixedBytes(utf8(value));
  }

  toBytes(): Uint8Array {
    return concatBytes(...this.parts);
  }
}

export class ByteReader {
  private offset = 0;

  constructor(private readonly input: Uint8Array) {}

  get remaining(): number {
    return this.input.byteLength - this.offset;
  }

  readU8(): number {
    this.require(1);
    return this.input[this.offset++];
  }

  readU16(): number {
    this.require(2);
    const value = (this.input[this.offset] << 8) | this.input[this.offset + 1];
    this.offset += 2;
    return value;
  }

  readU32(): number {
    this.require(4);
    const value =
      this.input[this.offset] * 0x1_00_00_00 +
      this.input[this.offset + 1] * 0x1_00_00 +
      this.input[this.offset + 2] * 0x100 +
      this.input[this.offset + 3];
    this.offset += 4;
    return value;
  }

  readU64(): bigint {
    this.require(8);
    let value = 0n;
    for (let index = 0; index < 8; index++) {
      value = (value << 8n) | BigInt(this.input[this.offset + index]);
    }
    this.offset += 8;
    return value;
  }

  readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError("byte length is invalid");
    }
    this.require(length);
    const value = this.input.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readLengthPrefixedBytes(): Uint8Array {
    return this.readBytes(this.readU16());
  }

  readLengthPrefixedString(): string {
    return decodeUtf8(this.readLengthPrefixedBytes());
  }

  assertDone(): void {
    if (this.remaining !== 0) throw new RangeError("trailing bytes");
  }

  private require(length: number): void {
    if (this.remaining < length) throw new RangeError("truncated byte sequence");
  }
}

function assertUnsignedInteger(value: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${label} is outside its unsigned range`);
  }
}
