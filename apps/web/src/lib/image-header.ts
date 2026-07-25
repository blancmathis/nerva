export type SupportedImageFormat = "png" | "jpeg" | "webp" | "heif";

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export interface InspectedImageHeader extends ImageDimensions {
  readonly format: SupportedImageFormat;
  /** Dimensions a browser decoder may expose (for example, a HEIF primary item). */
  readonly decodedDimensions: readonly ImageDimensions[];
  /** Every declared surface or coded frame that must satisfy allocation limits. */
  readonly safetyDimensions: readonly ImageDimensions[];
  /** Sum of coded primary/tile surfaces a decoder must process for one output. */
  readonly aggregateDecodedPixels: bigint;
}

const MAX_INSPECTION_BYTES = 256 * 1024;
const MAX_IMAGE_FILE_BYTES = 15 * 1024 * 1024;
const MAX_SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_STREAM_SCAN_BYTES = MAX_IMAGE_FILE_BYTES;
const MAX_STRUCTURES = 4_096;
const MAX_HEIF_PROPERTIES = 128;
const MAX_HEIF_TABLE_BYTES = 128 * 1024;
const MAX_HEVC_CONFIG_BYTES = 64 * 1024;
const MAX_HEIF_GRID_TILES = 256;
export const MAX_SAFE_IMAGE_DIMENSION = 16_384;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
]);

function invalidHeader(detail = "The image header is invalid or too complex to inspect safely."): Error {
  return new Error(detail);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return value;
}

function uint16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1_00_00_00 +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    ((bytes[offset + 1] ?? 0) << 8) +
    ((bytes[offset + 2] ?? 0) << 16) +
    (bytes[offset + 3] ?? 0) * 0x1_00_00_00
  );
}

function dimensions(width: number, height: number): ImageDimensions {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw invalidHeader("The image declares invalid dimensions.");
  }
  return { width, height };
}

function sameDimensions(left: ImageDimensions, right: ImageDimensions): boolean {
  return left.width === right.width && left.height === right.height;
}

function uniqueDimensions(values: readonly ImageDimensions[]): ImageDimensions[] {
  const result: ImageDimensions[] = [];
  for (const value of values) {
    if (!result.some((candidate) => sameDimensions(candidate, value))) result.push(value);
  }
  return result;
}

function maximumPixelCount(values: readonly ImageDimensions[]): bigint {
  let maximum = 0n;
  for (const value of values) {
    const pixels = BigInt(value.width) * BigInt(value.height);
    if (pixels > maximum) maximum = pixels;
  }
  return maximum;
}

class BoundedBlobReader {
  private inspectedBytes = 0;
  private streamedBytes = 0;
  private streamEnd = 0;
  private structures = 0;

  constructor(readonly blob: Blob) {}

  structure(): void {
    this.structures += 1;
    if (this.structures > MAX_STRUCTURES) throw invalidHeader();
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.blob.size
    ) {
      throw invalidHeader("The image header is truncated.");
    }
    this.inspectedBytes += length;
    if (this.inspectedBytes > MAX_INSPECTION_BYTES) throw invalidHeader();
    return this.readRange(offset, length);
  }

  async scan(offset: number, length: number): Promise<Uint8Array> {
    if (
      length < 1 ||
      length > MAX_SCAN_CHUNK_BYTES ||
      offset < this.streamEnd ||
      this.streamedBytes + length > MAX_STREAM_SCAN_BYTES
    ) {
      throw invalidHeader();
    }
    this.streamedBytes += length;
    this.streamEnd = offset + length;
    return this.readRange(offset, length);
  }

  private async readRange(offset: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.blob.size
    ) {
      throw invalidHeader("The image header is truncated.");
    }
    const range = this.blob.slice(offset, offset + length);
    if (typeof range.arrayBuffer === "function") {
      return new Uint8Array(await range.arrayBuffer());
    }
    if (typeof FileReader === "undefined") throw invalidHeader("Image header reading is unavailable.");
    return await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
        else reject(invalidHeader("Image header reading failed."));
      }, { once: true });
      reader.addEventListener("error", () => reject(invalidHeader("Image header reading failed.")), {
        once: true,
      });
      reader.readAsArrayBuffer(range);
    });
  }
}

class ForwardBlobScanner {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private bufferStart = 0;
  private position: number;

  constructor(private readonly reader: BoundedBlobReader, start: number) {
    this.position = start;
  }

  get offset(): number {
    return this.position;
  }

  seek(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < this.position || offset > this.reader.blob.size) {
      throw invalidHeader("The JPEG marker table is invalid.");
    }
    this.position = offset;
  }

  async readByte(): Promise<number> {
    if (this.position >= this.reader.blob.size) throw invalidHeader("The JPEG data is truncated.");
    const value = (await this.reader.read(this.position, 1))[0] ?? 0;
    this.position += 1;
    return value;
  }

  async scanByte(): Promise<number> {
    if (this.position >= this.reader.blob.size) throw invalidHeader("The JPEG data is truncated.");
    if (
      this.position < this.bufferStart ||
      this.position >= this.bufferStart + this.buffer.length
    ) {
      this.bufferStart = this.position;
      const length = Math.min(
        MAX_SCAN_CHUNK_BYTES,
        this.reader.blob.size - this.bufferStart,
      );
      this.buffer = await this.reader.scan(
        this.bufferStart,
        length,
      );
    }
    const value = this.buffer[this.position - this.bufferStart] ?? 0;
    this.position += 1;
    return value;
  }

  async readUint16(): Promise<number> {
    if (this.reader.blob.size - this.position < 2) {
      throw invalidHeader("The JPEG data is truncated.");
    }
    const bytes = await this.reader.read(this.position, 2);
    this.position += 2;
    return uint16be(bytes, 0);
  }
}

async function inspectPng(reader: BoundedBlobReader): Promise<InspectedImageHeader> {
  const signature = await reader.read(0, 8);
  if (!PNG_SIGNATURE.every((byte, index) => signature[index] === byte)) throw invalidHeader();
  let cursor = 8;
  let value: ImageDimensions | null = null;
  let sawImageData = false;
  let imageDataEnded = false;
  const validDepths: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  while (cursor < reader.blob.size) {
    reader.structure();
    if (reader.blob.size - cursor < 12) throw invalidHeader("The PNG chunk table is truncated.");
    const chunk = await reader.read(cursor, 8);
    const length = uint32be(chunk, 0);
    const type = ascii(chunk, 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) throw invalidHeader("The PNG chunk type is invalid.");
    const dataOffset = cursor + 8;
    const next = dataOffset + length + 4;
    if (!Number.isSafeInteger(next) || next > reader.blob.size) throw invalidHeader("The PNG chunk table is truncated.");

    if (type === "IHDR") {
      if (cursor !== 8 || value || length !== 13) throw invalidHeader("The PNG header is ambiguous.");
      const header = await reader.read(dataOffset, 13);
      value = dimensions(uint32be(header, 0), uint32be(header, 4));
      const bitDepth = header[8] ?? -1;
      const colorType = header[9] ?? -1;
      if (
        !validDepths[colorType]?.includes(bitDepth) ||
        header[10] !== 0 ||
        header[11] !== 0 ||
        (header[12] !== 0 && header[12] !== 1)
      ) {
        throw invalidHeader();
      }
    } else if (!value) {
      throw invalidHeader("The PNG does not begin with IHDR.");
    } else if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw invalidHeader("Animated PNG images are not accepted for image import.");
    } else if (type === "IDAT") {
      if (imageDataEnded) throw invalidHeader("The PNG image-data chunks are ambiguous.");
      sawImageData = true;
    } else {
      if (sawImageData) imageDataEnded = true;
      const critical = (type.charCodeAt(0) & 0x20) === 0;
      if (critical && type !== "PLTE" && type !== "IEND") {
        throw invalidHeader("The PNG contains an unsupported critical chunk.");
      }
    }

    cursor = next;
    if (type === "IEND") {
      if (length !== 0 || !sawImageData || cursor !== reader.blob.size || !value) {
        throw invalidHeader("The PNG ending is invalid or ambiguous.");
      }
      return {
        format: "png",
        ...value,
        decodedDimensions: [value],
        safetyDimensions: [value],
        aggregateDecodedPixels: BigInt(value.width) * BigInt(value.height),
      };
    }
  }
  throw invalidHeader("The PNG is missing IEND.");
}

const JPEG_START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2]);
const JPEG_UNSUPPORTED_START_OF_FRAME = new Set([
  0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

async function inspectJpeg(reader: BoundedBlobReader): Promise<InspectedImageHeader> {
  const signature = await reader.read(0, 2);
  if (signature[0] !== 0xff || signature[1] !== 0xd8) throw invalidHeader();
  const scanner = new ForwardBlobScanner(reader, 2);
  let found: ImageDimensions | null = null;
  let inEntropyData = false;
  let sawScan = false;

  while (scanner.offset < reader.blob.size) {
    reader.structure();
    let marker: number;
    if (inEntropyData) {
      while (true) {
        if (await scanner.scanByte() !== 0xff) continue;
        do {
          marker = await scanner.scanByte();
        } while (marker === 0xff);
        if (marker === 0x00) continue;
        if (marker >= 0xd0 && marker <= 0xd7) {
          reader.structure();
          continue;
        }
        inEntropyData = false;
        break;
      }
    } else {
      if (await scanner.readByte() !== 0xff) throw invalidHeader("The JPEG marker table is invalid.");
      do {
        marker = await scanner.readByte();
      } while (marker === 0xff);
      if (marker === 0x00) throw invalidHeader("The JPEG marker table is invalid.");
    }

    if (marker === 0xd9) {
      if (!found || !sawScan || scanner.offset !== reader.blob.size) {
        throw invalidHeader("The JPEG ending is invalid or ambiguous.");
      }
      return {
        format: "jpeg",
        ...found,
        decodedDimensions: [found],
        safetyDimensions: [found],
        aggregateDecodedPixels: BigInt(found.width) * BigInt(found.height),
      };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) throw invalidHeader();
    if (marker === 0x01) continue;
    if (marker === 0xde || marker === 0xdf || JPEG_UNSUPPORTED_START_OF_FRAME.has(marker)) {
      throw invalidHeader("Hierarchical or differential JPEG images are not accepted for import.");
    }

    const segmentLength = await scanner.readUint16();
    const segmentEnd = scanner.offset + segmentLength - 2;
    if (segmentLength < 2 || segmentEnd > reader.blob.size) throw invalidHeader();
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (found) {
        throw invalidHeader("The JPEG header contains multiple or ambiguous frame declarations.");
      }
      if (segmentLength < 8) throw invalidHeader();
      const precision = await scanner.readByte();
      const height = await scanner.readUint16();
      const width = await scanner.readUint16();
      const components = await scanner.readByte();
      const candidate = dimensions(width, height);
      if (
        precision !== 8 ||
        components < 1 ||
        components > 4 ||
        segmentLength !== 8 + components * 3
      ) {
        throw invalidHeader("The JPEG frame header is unsupported.");
      }
      const componentIds = new Set<number>();
      let samplingBlocks = 0;
      for (let index = 0; index < components; index += 1) {
        const componentId = await scanner.readByte();
        const sampling = await scanner.readByte();
        const quantizationTable = await scanner.readByte();
        const horizontalSampling = sampling >> 4;
        const verticalSampling = sampling & 0x0f;
        if (
          componentIds.has(componentId) ||
          horizontalSampling < 1 ||
          horizontalSampling > 4 ||
          verticalSampling < 1 ||
          verticalSampling > 4 ||
          quantizationTable > 3
        ) {
          throw invalidHeader("The JPEG frame components are unsupported.");
        }
        componentIds.add(componentId);
        samplingBlocks += horizontalSampling * verticalSampling;
      }
      if (samplingBlocks > 10 || scanner.offset !== segmentEnd) {
        throw invalidHeader("The JPEG frame components are unsupported.");
      }
      found = candidate;
    } else if (marker === 0xda) {
      if (!found || segmentLength < 6) throw invalidHeader();
      sawScan = true;
      inEntropyData = true;
    } else if (marker === 0xdc) {
      throw invalidHeader("JPEG DNL dimensions are not accepted for import.");
    }
    scanner.seek(segmentEnd);
  }
  throw invalidHeader("The JPEG is missing a valid EOI marker.");
}

async function inspectWebp(reader: BoundedBlobReader): Promise<InspectedImageHeader> {
  const header = await reader.read(0, 12);
  if (ascii(header, 0, 4) !== "RIFF" || ascii(header, 8, 4) !== "WEBP") throw invalidHeader();
  const riffEnd = uint32le(header, 4) + 8;
  if (riffEnd < 20 || riffEnd !== reader.blob.size) throw invalidHeader();

  let cursor = 12;
  let canvas: ImageDimensions | null = null;
  const bitstreams: ImageDimensions[] = [];
  while (cursor + 8 <= riffEnd) {
    reader.structure();
    const chunkHeader = await reader.read(cursor, 8);
    const type = ascii(chunkHeader, 0, 4);
    const length = uint32le(chunkHeader, 4);
    const dataOffset = cursor + 8;
    const paddedLength = length + (length & 1);
    if (!Number.isSafeInteger(paddedLength) || dataOffset + paddedLength > riffEnd) throw invalidHeader();

    if (type === "VP8X") {
      if (canvas || length !== 10) throw invalidHeader("The WebP header declares ambiguous dimensions.");
      const payload = await reader.read(dataOffset, 10);
      const extendedFlags = payload[0] ?? 0;
      if ((extendedFlags & 0xc1) !== 0 || (extendedFlags & 0x02) !== 0) {
        throw invalidHeader("Animated or reserved WebP features are not accepted for image import.");
      }
      canvas = dimensions(uint24le(payload, 4) + 1, uint24le(payload, 7) + 1);
    } else if (type === "VP8 ") {
      if (length < 10) throw invalidHeader();
      const payload = await reader.read(dataOffset, 10);
      if (payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) throw invalidHeader();
      const width = ((payload[6] ?? 0) | ((payload[7] ?? 0) << 8)) & 0x3fff;
      const height = ((payload[8] ?? 0) | ((payload[9] ?? 0) << 8)) & 0x3fff;
      bitstreams.push(dimensions(width, height));
    } else if (type === "VP8L") {
      if (length < 5) throw invalidHeader();
      const payload = await reader.read(dataOffset, 5);
      if (payload[0] !== 0x2f) throw invalidHeader();
      bitstreams.push(dimensions(
        1 + (payload[1] ?? 0) + (((payload[2] ?? 0) & 0x3f) << 8),
        1 + (((payload[2] ?? 0) >> 6) | ((payload[3] ?? 0) << 2) | (((payload[4] ?? 0) & 0x0f) << 10)),
      ));
    } else if (type === "ANIM" || type === "ANMF") {
      throw invalidHeader("Animated WebP images are not accepted for image import.");
    }
    cursor = dataOffset + paddedLength;
  }
  if (cursor !== riffEnd) throw invalidHeader();
  if (bitstreams.length > 1) throw invalidHeader("The WebP header declares ambiguous image data.");
  if (canvas && bitstreams.length !== 1) {
    throw invalidHeader("The WebP header does not contain one bounded still-image frame.");
  }

  const declared = uniqueDimensions(canvas ? [canvas] : bitstreams);
  if (declared.length !== 1) throw invalidHeader("The WebP header declares ambiguous dimensions.");
  if (canvas) {
    for (const frame of bitstreams) {
      if (frame.width > canvas.width || frame.height > canvas.height) throw invalidHeader();
    }
  }
  const value = declared[0]!;
  return {
    format: "webp",
    ...value,
    decodedDimensions: [value],
    safetyDimensions: [value],
    aggregateDecodedPixels: BigInt(value.width) * BigInt(value.height),
  };
}

interface BoxHeader {
  readonly type: string;
  readonly end: number;
  readonly contentStart: number;
}

async function readBoxHeader(
  reader: BoundedBlobReader,
  offset: number,
  parentEnd: number,
): Promise<BoxHeader> {
  reader.structure();
  const basic = await reader.read(offset, 8);
  const size32 = uint32be(basic, 0);
  const type = ascii(basic, 4, 4);
  let headerSize = 8;
  let size = size32;
  if (size32 === 1) {
    const extended = await reader.read(offset + 8, 8);
    const high = uint32be(extended, 0);
    const low = uint32be(extended, 4);
    const fullSize = BigInt(high) * 0x1_00_00_00n + BigInt(low);
    if (fullSize > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidHeader();
    size = Number(fullSize);
    headerSize = 16;
  } else if (size32 === 0) {
    size = parentEnd - offset;
  }
  if (size < headerSize || offset + size > parentEnd) throw invalidHeader("The HEIC/HEIF header is truncated.");
  return { type, end: offset + size, contentStart: offset + headerSize };
}

async function boxesBetween(
  reader: BoundedBlobReader,
  start: number,
  end: number,
): Promise<BoxHeader[]> {
  const boxes: BoxHeader[] = [];
  let cursor = start;
  while (cursor < end) {
    if (end - cursor < 8) throw invalidHeader("The HEIC/HEIF header is truncated.");
    const box = await readBoxHeader(reader, cursor, end);
    boxes.push(box);
    cursor = box.end;
  }
  return boxes;
}

function fullBoxFlags(bytes: Uint8Array): number {
  return ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
}

function sizedUint(bytes: Uint8Array, offset: number, size: number): number {
  if (!Number.isInteger(size) || size < 0 || size > 8 || offset < 0 || offset + size > bytes.length) {
    throw invalidHeader("The HEIC/HEIF metadata table is truncated.");
  }
  let value = 0n;
  for (let index = 0; index < size; index += 1) {
    value = value * 256n + BigInt(bytes[offset + index] ?? 0);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidHeader();
  return Number(value);
}

class BitReader {
  private bitOffset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readBits(count: number): number {
    if (!Number.isInteger(count) || count < 0 || count > 32 || this.bitOffset + count > this.bytes.length * 8) {
      throw invalidHeader("The HEVC sequence header is truncated.");
    }
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const absolute = this.bitOffset + index;
      value = value * 2 + (((this.bytes[absolute >> 3] ?? 0) >> (7 - (absolute & 7))) & 1);
    }
    this.bitOffset += count;
    return value;
  }

  skip(count: number): void {
    if (!Number.isInteger(count) || count < 0 || this.bitOffset + count > this.bytes.length * 8) {
      throw invalidHeader("The HEVC sequence header is truncated.");
    }
    this.bitOffset += count;
  }

  readUnsignedExpGolomb(): number {
    let leadingZeros = 0;
    while (this.readBits(1) === 0) {
      leadingZeros += 1;
      if (leadingZeros > 31) throw invalidHeader("The HEVC sequence header is ambiguous.");
    }
    return 2 ** leadingZeros - 1 + this.readBits(leadingZeros);
  }
}

export function removeHevcEmulationPrevention(bytes: Uint8Array): Uint8Array {
  const result: number[] = [];
  let consecutiveInputZeros = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte === 0x03 && consecutiveInputZeros >= 2) {
      const next = bytes[index + 1];
      if (next === undefined || next > 0x03) throw invalidHeader("The HEVC sequence header is invalid.");
      consecutiveInputZeros = 0;
      continue;
    }
    result.push(byte);
    consecutiveInputZeros = byte === 0 ? Math.min(2, consecutiveInputZeros + 1) : 0;
  }
  return Uint8Array.from(result);
}

interface HevcSpsInfo {
  readonly coded: ImageDimensions;
  readonly display: ImageDimensions;
}

function inspectHevcSps(nalUnit: Uint8Array): HevcSpsInfo {
  if (nalUnit.length < 4 || (((nalUnit[0] ?? 0) >> 1) & 0x3f) !== 33) {
    throw invalidHeader("The HEVC configuration does not contain a valid SPS.");
  }
  const bits = new BitReader(removeHevcEmulationPrevention(nalUnit.slice(2)));
  bits.skip(4);
  const maxSubLayersMinusOne = bits.readBits(3);
  if (maxSubLayersMinusOne > 6) throw invalidHeader("The HEVC SPS declares too many sub-layers.");
  bits.skip(1);

  // profile_tier_level general profile (88 bits) + general_level_idc (8 bits).
  bits.skip(96);
  const subLayerProfiles: boolean[] = [];
  const subLayerLevels: boolean[] = [];
  for (let index = 0; index < maxSubLayersMinusOne; index += 1) {
    subLayerProfiles.push(bits.readBits(1) === 1);
    subLayerLevels.push(bits.readBits(1) === 1);
  }
  if (maxSubLayersMinusOne > 0) bits.skip((8 - maxSubLayersMinusOne) * 2);
  for (let index = 0; index < maxSubLayersMinusOne; index += 1) {
    if (subLayerProfiles[index]) bits.skip(88);
    if (subLayerLevels[index]) bits.skip(8);
  }

  bits.readUnsignedExpGolomb();
  const chromaFormatIdc = bits.readUnsignedExpGolomb();
  if (chromaFormatIdc > 3) throw invalidHeader("The HEVC SPS declares an invalid chroma format.");
  const separateColourPlane = chromaFormatIdc === 3 && bits.readBits(1) === 1;
  const codedWidth = bits.readUnsignedExpGolomb();
  const codedHeight = bits.readUnsignedExpGolomb();
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  if (bits.readBits(1) === 1) {
    left = bits.readUnsignedExpGolomb();
    right = bits.readUnsignedExpGolomb();
    top = bits.readUnsignedExpGolomb();
    bottom = bits.readUnsignedExpGolomb();
  }
  const subWidth = separateColourPlane || chromaFormatIdc === 0 || chromaFormatIdc === 3 ? 1 : 2;
  const subHeight = separateColourPlane || chromaFormatIdc !== 1 ? 1 : 2;
  return {
    coded: dimensions(codedWidth, codedHeight),
    display: dimensions(
      codedWidth - subWidth * (left + right),
      codedHeight - subHeight * (top + bottom),
    ),
  };
}

interface HevcConfiguration {
  readonly codedDimensions: readonly ImageDimensions[];
  readonly displayDimensions: readonly ImageDimensions[];
  readonly nalLengthSize: number;
}

async function inspectHvcConfiguration(
  reader: BoundedBlobReader,
  property: BoxHeader,
): Promise<HevcConfiguration> {
  const length = property.end - property.contentStart;
  if (length < 23 || length > MAX_HEVC_CONFIG_BYTES) throw invalidHeader("The HEVC configuration is invalid.");
  const bytes = await reader.read(property.contentStart, length);
  if (bytes[0] !== 1) throw invalidHeader("The HEVC configuration version is unsupported.");
  const arrayCount = bytes[22] ?? 0;
  let cursor = 23;
  let totalNalUnits = 0;
  const declared: HevcSpsInfo[] = [];
  for (let arrayIndex = 0; arrayIndex < arrayCount; arrayIndex += 1) {
    if (cursor + 3 > bytes.length) throw invalidHeader("The HEVC configuration is truncated.");
    const arrayHeader = bytes[cursor] ?? 0;
    if ((arrayHeader & 0x40) !== 0) throw invalidHeader("The HEVC configuration is invalid.");
    const nalType = arrayHeader & 0x3f;
    const nalCount = uint16be(bytes, cursor + 1);
    totalNalUnits += nalCount;
    if (totalNalUnits > MAX_STRUCTURES) throw invalidHeader();
    cursor += 3;
    for (let nalIndex = 0; nalIndex < nalCount; nalIndex += 1) {
      if (cursor + 2 > bytes.length) throw invalidHeader("The HEVC configuration is truncated.");
      const nalLength = uint16be(bytes, cursor);
      cursor += 2;
      if (nalLength <= 0 || cursor + nalLength > bytes.length) {
        throw invalidHeader("The HEVC configuration is truncated.");
      }
      const nal = bytes.subarray(cursor, cursor + nalLength);
      const actualType = ((nal[0] ?? 0) >> 1) & 0x3f;
      if (actualType !== nalType) throw invalidHeader("The HEVC configuration is ambiguous.");
      if (nalType === 33) declared.push(inspectHevcSps(nal));
      cursor += nalLength;
    }
  }
  if (cursor !== bytes.length || declared.length === 0) {
    throw invalidHeader("The HEVC configuration does not contain one bounded SPS.");
  }
  return {
    codedDimensions: uniqueDimensions(declared.map((entry) => entry.coded)),
    displayDimensions: uniqueDimensions(declared.map((entry) => entry.display)),
    nalLengthSize: ((bytes[21] ?? 0) & 0x03) + 1,
  };
}

async function parsePrimaryItemId(reader: BoundedBlobReader, pitm: BoxHeader): Promise<number> {
  const length = pitm.end - pitm.contentStart;
  if (length !== 6 && length !== 8) throw invalidHeader("The HEIC/HEIF primary-item box is invalid.");
  const bytes = await reader.read(pitm.contentStart, length);
  const version = bytes[0] ?? -1;
  if (fullBoxFlags(bytes) !== 0 || (version !== 0 && version !== 1)) throw invalidHeader();
  if ((version === 0 && length !== 6) || (version === 1 && length !== 8)) throw invalidHeader();
  return sizedUint(bytes, 4, version === 0 ? 2 : 4);
}

async function parseItemTypes(
  reader: BoundedBlobReader,
  iinf: BoxHeader,
): Promise<ReadonlyMap<number, string>> {
  if (iinf.end - iinf.contentStart < 6) throw invalidHeader();
  const prefix = await reader.read(iinf.contentStart, Math.min(8, iinf.end - iinf.contentStart));
  const version = prefix[0] ?? -1;
  if (fullBoxFlags(prefix) !== 0 || version > 1) throw invalidHeader("The HEIC/HEIF item table is unsupported.");
  const countSize = version === 0 ? 2 : 4;
  const itemCount = sizedUint(prefix, 4, countSize);
  const entries = await boxesBetween(reader, iinf.contentStart + 4 + countSize, iinf.end);
  if (entries.length !== itemCount || entries.some((entry) => entry.type !== "infe")) throw invalidHeader();

  const result = new Map<number, string>();
  for (const entry of entries) {
    const length = entry.end - entry.contentStart;
    if (length < 13 || length > 4_096) throw invalidHeader();
    const bytes = await reader.read(entry.contentStart, length);
    const entryVersion = bytes[0] ?? -1;
    if ((fullBoxFlags(bytes) & ~1) !== 0 || (entryVersion !== 2 && entryVersion !== 3)) {
      throw invalidHeader("The HEIC/HEIF item-info version is unsupported.");
    }
    const idSize = entryVersion === 2 ? 2 : 4;
    const itemId = sizedUint(bytes, 4, idSize);
    const typeOffset = 4 + idSize + 2;
    const itemType = ascii(bytes, typeOffset, 4);
    if (bytes.indexOf(0, typeOffset + 4) < 0 || result.has(itemId)) throw invalidHeader();
    result.set(itemId, itemType);
  }
  return result;
}

async function parseItemAssociations(
  reader: BoundedBlobReader,
  ipma: BoxHeader,
  propertyCount: number,
): Promise<ReadonlyMap<number, readonly number[]>> {
  const length = ipma.end - ipma.contentStart;
  if (length < 8 || length > MAX_HEIF_TABLE_BYTES) throw invalidHeader();
  const bytes = await reader.read(ipma.contentStart, length);
  const version = bytes[0] ?? -1;
  const flags = fullBoxFlags(bytes);
  if ((version !== 0 && version !== 1) || (flags & ~1) !== 0) throw invalidHeader();
  const wideAssociations = (flags & 1) !== 0;
  const entryCount = uint32be(bytes, 4);
  if (entryCount > MAX_STRUCTURES) throw invalidHeader();
  let cursor = 8;
  const result = new Map<number, readonly number[]>();
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    const itemIdSize = version === 0 ? 2 : 4;
    const itemId = sizedUint(bytes, cursor, itemIdSize);
    cursor += itemIdSize;
    if (cursor >= bytes.length || result.has(itemId)) throw invalidHeader();
    const associationCount = bytes[cursor] ?? 0;
    cursor += 1;
    const propertyIndexes: number[] = [];
    for (let associationIndex = 0; associationIndex < associationCount; associationIndex += 1) {
      const associationSize = wideAssociations ? 2 : 1;
      const association = sizedUint(bytes, cursor, associationSize);
      cursor += associationSize;
      const propertyIndex = association & (wideAssociations ? 0x7fff : 0x7f);
      if (
        propertyIndex <= 0 ||
        propertyIndex > propertyCount ||
        propertyIndexes.includes(propertyIndex)
      ) {
        throw invalidHeader("The HEIC/HEIF property associations are ambiguous.");
      }
      propertyIndexes.push(propertyIndex);
    }
    result.set(itemId, propertyIndexes);
  }
  if (cursor !== bytes.length) throw invalidHeader("The HEIC/HEIF property table is ambiguous.");
  return result;
}

interface ItemLocation {
  readonly constructionMethod: number;
  readonly baseOffset: number;
  readonly extents: readonly { readonly offset: number; readonly length: number }[];
}

interface ResolvedExtent {
  readonly start: number;
  readonly end: number;
}

async function parseItemLocations(
  reader: BoundedBlobReader,
  iloc: BoxHeader,
): Promise<ReadonlyMap<number, ItemLocation>> {
  const length = iloc.end - iloc.contentStart;
  if (length < 8 || length > MAX_HEIF_TABLE_BYTES) throw invalidHeader();
  const bytes = await reader.read(iloc.contentStart, length);
  const version = bytes[0] ?? -1;
  if (fullBoxFlags(bytes) !== 0 || version < 0 || version > 2) throw invalidHeader();
  const offsetSize = (bytes[4] ?? 0) >> 4;
  const lengthSize = (bytes[4] ?? 0) & 0x0f;
  const baseOffsetSize = (bytes[5] ?? 0) >> 4;
  const indexSize = version === 0 ? 0 : (bytes[5] ?? 0) & 0x0f;
  for (const size of [offsetSize, lengthSize, baseOffsetSize, indexSize]) {
    if (size > 8) throw invalidHeader();
  }
  let cursor = 6;
  const itemCountSize = version < 2 ? 2 : 4;
  const itemCount = sizedUint(bytes, cursor, itemCountSize);
  if (itemCount > MAX_STRUCTURES) throw invalidHeader();
  cursor += itemCountSize;
  const result = new Map<number, ItemLocation>();
  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    const itemIdSize = version < 2 ? 2 : 4;
    const itemId = sizedUint(bytes, cursor, itemIdSize);
    cursor += itemIdSize;
    let constructionMethod = 0;
    if (version > 0) {
      const methodField = sizedUint(bytes, cursor, 2);
      cursor += 2;
      if ((methodField & 0xfff0) !== 0) throw invalidHeader();
      constructionMethod = methodField & 0x0f;
    }
    const dataReferenceIndex = sizedUint(bytes, cursor, 2);
    cursor += 2;
    if (dataReferenceIndex !== 0 || result.has(itemId)) throw invalidHeader();
    const baseOffset = sizedUint(bytes, cursor, baseOffsetSize);
    cursor += baseOffsetSize;
    const extentCount = sizedUint(bytes, cursor, 2);
    cursor += 2;
    if (extentCount > MAX_STRUCTURES) throw invalidHeader();
    const extents: { offset: number; length: number }[] = [];
    for (let extentIndex = 0; extentIndex < extentCount; extentIndex += 1) {
      if (indexSize > 0) {
        const index = sizedUint(bytes, cursor, indexSize);
        cursor += indexSize;
        if (index !== 0) throw invalidHeader("Indexed HEIC/HEIF extents are unsupported.");
      }
      const offset = sizedUint(bytes, cursor, offsetSize);
      cursor += offsetSize;
      const extentLength = sizedUint(bytes, cursor, lengthSize);
      cursor += lengthSize;
      extents.push({ offset, length: extentLength });
    }
    result.set(itemId, { constructionMethod, baseOffset, extents });
  }
  if (cursor !== bytes.length) throw invalidHeader();
  return result;
}

function resolveSingleItemExtent(
  reader: BoundedBlobReader,
  location: ItemLocation | undefined,
  metaChildren: readonly BoxHeader[],
): ResolvedExtent {
  if (!location || location.extents.length !== 1) {
    throw invalidHeader("The HEIC/HEIF item extent is ambiguous.");
  }
  const extent = location.extents[0]!;
  if (extent.length <= 0) throw invalidHeader("The HEIC/HEIF item extent is empty.");
  let start = location.baseOffset + extent.offset;
  let enclosingEnd = reader.blob.size;
  if (!Number.isSafeInteger(start)) throw invalidHeader();
  if (location.constructionMethod === 1) {
    const idatBoxes = metaChildren.filter((box) => box.type === "idat");
    if (idatBoxes.length !== 1) throw invalidHeader("The HEIC/HEIF item data is ambiguous.");
    start += idatBoxes[0]!.contentStart;
    enclosingEnd = idatBoxes[0]!.end;
  } else if (location.constructionMethod !== 0) {
    throw invalidHeader("This HEIC/HEIF item construction method is unsupported.");
  }
  const end = start + extent.length;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end > enclosingEnd) {
    throw invalidHeader("The HEIC/HEIF item extent is truncated.");
  }
  return { start, end };
}

async function validateHvcItemBitstream(
  reader: BoundedBlobReader,
  extent: ResolvedExtent,
  nalLengthSize: number,
): Promise<void> {
  let cursor = extent.start;
  while (cursor < extent.end) {
    reader.structure();
    if (extent.end - cursor < nalLengthSize + 2) throw invalidHeader("The HEVC item data is truncated.");
    const lengthBytes = await reader.read(cursor, nalLengthSize);
    const nalLength = sizedUint(lengthBytes, 0, nalLengthSize);
    cursor += nalLengthSize;
    if (nalLength < 2 || cursor + nalLength > extent.end) throw invalidHeader("The HEVC item data is truncated.");
    const header = await reader.read(cursor, 2);
    const nalType = ((header[0] ?? 0) >> 1) & 0x3f;
    if (((header[0] ?? 0) & 0x80) !== 0 || ((header[1] ?? 0) & 0x07) === 0) {
      throw invalidHeader("The HEVC item NAL header is invalid.");
    }
    if (nalType === 32 || nalType === 33 || nalType === 34) {
      throw invalidHeader("In-band HEVC parameter sets are not accepted for HEIC/HEIF import.");
    }
    cursor += nalLength;
  }
}

interface GridDescriptor extends ImageDimensions {
  readonly tileCount: number;
}

async function inspectGridDescriptor(
  reader: BoundedBlobReader,
  primaryItemId: number,
  metaChildren: readonly BoxHeader[],
  locations: ReadonlyMap<number, ItemLocation>,
): Promise<GridDescriptor> {
  const resolved = resolveSingleItemExtent(reader, locations.get(primaryItemId), metaChildren);
  const length = resolved.end - resolved.start;
  if (length !== 8 && length !== 12) throw invalidHeader("The HEIC/HEIF grid descriptor is invalid.");
  const payload = await reader.read(resolved.start, length);
  if (payload[0] !== 0 || ((payload[1] ?? 0) & ~1) !== 0) throw invalidHeader();
  const wide = ((payload[1] ?? 0) & 1) !== 0;
  if (length !== (wide ? 12 : 8)) throw invalidHeader();
  const size = wide ? 4 : 2;
  return {
    ...dimensions(sizedUint(payload, 4, size), sizedUint(payload, 4 + size, size)),
    tileCount: ((payload[2] ?? 0) + 1) * ((payload[3] ?? 0) + 1),
  };
}

async function parseDerivedImageReferences(
  reader: BoundedBlobReader,
  iref: BoxHeader,
): Promise<ReadonlyMap<number, readonly number[]>> {
  if (iref.end - iref.contentStart < 4) throw invalidHeader();
  const fullBox = await reader.read(iref.contentStart, 4);
  const version = fullBox[0] ?? -1;
  if (fullBoxFlags(fullBox) !== 0 || (version !== 0 && version !== 1)) throw invalidHeader();
  const references = await boxesBetween(reader, iref.contentStart + 4, iref.end);
  const result = new Map<number, readonly number[]>();
  const idSize = version === 0 ? 2 : 4;
  for (const reference of references) {
    if (reference.type !== "dimg") continue;
    const length = reference.end - reference.contentStart;
    if (length < idSize + 2 || length > MAX_HEIF_TABLE_BYTES) throw invalidHeader();
    const bytes = await reader.read(reference.contentStart, length);
    const fromId = sizedUint(bytes, 0, idSize);
    const count = sizedUint(bytes, idSize, 2);
    if (count > MAX_HEIF_GRID_TILES) {
      throw invalidHeader(`The HEIC/HEIF grid exceeds the ${MAX_HEIF_GRID_TILES}-tile safety limit.`);
    }
    if (length !== idSize + 2 + count * idSize || result.has(fromId)) throw invalidHeader();
    const targets: number[] = [];
    const uniqueTargets = new Set<number>();
    let cursor = idSize + 2;
    for (let index = 0; index < count; index += 1) {
      const target = sizedUint(bytes, cursor, idSize);
      cursor += idSize;
      if (uniqueTargets.has(target)) throw invalidHeader();
      uniqueTargets.add(target);
      targets.push(target);
    }
    result.set(fromId, targets);
  }
  return result;
}

async function inspectHeif(reader: BoundedBlobReader): Promise<InspectedImageHeader> {
  const topLevel = await boxesBetween(reader, 0, reader.blob.size);
  const ftypBoxes = topLevel.filter((box) => box.type === "ftyp");
  const metaBoxes = topLevel.filter((box) => box.type === "meta");
  if (ftypBoxes.length !== 1 || metaBoxes.length !== 1) throw invalidHeader("The HEIC/HEIF container is ambiguous.");

  const ftyp = ftypBoxes[0]!;
  const ftypLength = ftyp.end - ftyp.contentStart;
  if (ftypLength < 8 || ftypLength > 4_096 || ftypLength % 4 !== 0) throw invalidHeader();
  const brands = await reader.read(ftyp.contentStart, ftypLength);
  const declaredBrands: string[] = [ascii(brands, 0, 4)];
  for (let offset = 8; offset < brands.length; offset += 4) declaredBrands.push(ascii(brands, offset, 4));
  if (!declaredBrands.some((brand) => HEIF_BRANDS.has(brand))) {
    throw invalidHeader("The file does not declare an unambiguous HEIC/HEIF brand.");
  }

  const meta = metaBoxes[0]!;
  if (meta.end - meta.contentStart < 12) throw invalidHeader();
  const fullBox = await reader.read(meta.contentStart, 4);
  if (fullBox.some((byte) => byte !== 0)) {
    throw invalidHeader("This HEIC/HEIF metadata version is unsupported.");
  }
  const metaChildren = await boxesBetween(reader, meta.contentStart + 4, meta.end);
  const pitmBoxes = metaChildren.filter((box) => box.type === "pitm");
  const iinfBoxes = metaChildren.filter((box) => box.type === "iinf");
  if (pitmBoxes.length !== 1 || iinfBoxes.length !== 1) {
    throw invalidHeader("The HEIC/HEIF primary item is ambiguous.");
  }
  const primaryItemId = await parsePrimaryItemId(reader, pitmBoxes[0]!);
  const itemTypes = await parseItemTypes(reader, iinfBoxes[0]!);
  const primaryItemType = itemTypes.get(primaryItemId);
  if (!primaryItemType) throw invalidHeader("The HEIC/HEIF primary item is missing.");
  const ilocBoxes = metaChildren.filter((box) => box.type === "iloc");
  if (ilocBoxes.length !== 1) throw invalidHeader("The HEIC/HEIF item locations are ambiguous.");
  const itemLocations = await parseItemLocations(reader, ilocBoxes[0]!);

  const iprpBoxes = metaChildren.filter((box) => box.type === "iprp");
  if (iprpBoxes.length !== 1) throw invalidHeader("The HEIC/HEIF image properties are ambiguous.");
  const iprpChildren = await boxesBetween(reader, iprpBoxes[0]!.contentStart, iprpBoxes[0]!.end);
  const ipcoBoxes = iprpChildren.filter((box) => box.type === "ipco");
  if (ipcoBoxes.length !== 1) throw invalidHeader("The HEIC/HEIF image properties are ambiguous.");
  const properties = await boxesBetween(reader, ipcoBoxes[0]!.contentStart, ipcoBoxes[0]!.end);
  if (properties.length > MAX_HEIF_PROPERTIES) throw invalidHeader();
  const ipmaBoxes = iprpChildren.filter((box) => box.type === "ipma");
  if (ipmaBoxes.length !== 1) throw invalidHeader("The HEIC/HEIF property associations are ambiguous.");
  const associations = await parseItemAssociations(reader, ipmaBoxes[0]!, properties.length);
  for (const itemId of associations.keys()) {
    if (!itemTypes.has(itemId)) throw invalidHeader("The HEIC/HEIF property table references an unknown item.");
  }

  const spatialProperties = new Map<number, ImageDimensions>();
  for (let index = 0; index < properties.length; index += 1) {
    const property = properties[index]!;
    if (property.type !== "ispe") continue;
    if (property.end - property.contentStart !== 12) throw invalidHeader();
    const payload = await reader.read(property.contentStart, 12);
    if (payload.some((byte, payloadIndex) => payloadIndex < 4 && byte !== 0)) throw invalidHeader();
    spatialProperties.set(index + 1, dimensions(uint32be(payload, 4), uint32be(payload, 8)));
  }

  const propertyIndexes = (itemId: number, type: string): number[] =>
    (associations.get(itemId) ?? []).filter((index) => properties[index - 1]?.type === type);
  const primarySpatialIndexes = propertyIndexes(primaryItemId, "ispe");
  if (primarySpatialIndexes.length !== 1) {
    throw invalidHeader("The HEIC/HEIF primary spatial extent is ambiguous.");
  }
  const primaryDimensions = spatialProperties.get(primarySpatialIndexes[0]!);
  if (!primaryDimensions) throw invalidHeader("The HEIC/HEIF primary spatial extent is missing.");

  const safetyDimensions: ImageDimensions[] = [primaryDimensions];
  const codecProperties = new Map<number, HevcConfiguration>();
  const validatedHvcItems = new Map<number, HevcConfiguration>();
  for (const [itemId, itemType] of itemTypes) {
    const associated = associations.get(itemId) ?? [];
    for (const propertyIndex of associated) {
      const spatial = spatialProperties.get(propertyIndex);
      if (spatial) safetyDimensions.push(spatial);
      if (properties[propertyIndex - 1]?.type === "hvcC") {
        if (itemType !== "hvc1") {
          throw invalidHeader("An HEVC configuration is associated with a non-HEVC item.");
        }
        let codecDimensions = codecProperties.get(propertyIndex);
        if (!codecDimensions) {
          codecDimensions = await inspectHvcConfiguration(reader, properties[propertyIndex - 1]!);
          codecProperties.set(propertyIndex, codecDimensions);
        }
        safetyDimensions.push(...codecDimensions.displayDimensions, ...codecDimensions.codedDimensions);
      }
    }

    if (itemType !== "hvc1") continue;
    const itemSpatialIndexes = propertyIndexes(itemId, "ispe");
    const itemCodecIndexes = propertyIndexes(itemId, "hvcC");
    if (itemSpatialIndexes.length !== 1 || itemCodecIndexes.length !== 1) {
      throw invalidHeader("An HEVC item does not have one unambiguous spatial extent and codec configuration.");
    }
    const itemSpatial = spatialProperties.get(itemSpatialIndexes[0]!);
    const itemCodecDimensions = codecProperties.get(itemCodecIndexes[0]!);
    if (
      !itemSpatial ||
      !itemCodecDimensions?.displayDimensions.some(
        (candidate) =>
          sameDimensions(candidate, itemSpatial) ||
          (candidate.width === itemSpatial.height && candidate.height === itemSpatial.width),
      )
    ) {
      throw invalidHeader("The HEVC coded dimensions do not match their associated spatial extent.");
    }
    await validateHvcItemBitstream(
      reader,
      resolveSingleItemExtent(reader, itemLocations.get(itemId), metaChildren),
      itemCodecDimensions.nalLengthSize,
    );
    validatedHvcItems.set(itemId, itemCodecDimensions);
  }

  let aggregateDecodedPixels = 0n;
  for (const codec of validatedHvcItems.values()) {
    aggregateDecodedPixels += maximumPixelCount(codec.codedDimensions);
  }

  const gridItemIds = Array.from(itemTypes, ([itemId, itemType]) =>
    itemType === "grid" ? itemId : null
  ).filter((itemId): itemId is number => itemId !== null);
  const irefBoxes = metaChildren.filter((box) => box.type === "iref");
  if (gridItemIds.length > 0 && irefBoxes.length !== 1) {
    throw invalidHeader("The HEIC/HEIF grid references are ambiguous.");
  }
  const derivedReferences = gridItemIds.length > 0
    ? await parseDerivedImageReferences(reader, irefBoxes[0]!)
    : new Map<number, readonly number[]>();
  const validatedGridItems = new Set<number>();
  for (const gridItemId of gridItemIds) {
    const gridSpatialIndexes = propertyIndexes(gridItemId, "ispe");
    if (gridSpatialIndexes.length !== 1) {
      throw invalidHeader("A HEIC/HEIF grid does not have one associated spatial extent.");
    }
    const gridSpatial = spatialProperties.get(gridSpatialIndexes[0]!);
    if (!gridSpatial) throw invalidHeader();
    const grid = await inspectGridDescriptor(reader, gridItemId, metaChildren, itemLocations);
    if (!sameDimensions(grid, gridSpatial)) {
      throw invalidHeader("The HEIC/HEIF grid output does not match its associated spatial extent.");
    }
    if (grid.tileCount > MAX_HEIF_GRID_TILES) {
      throw invalidHeader(`The HEIC/HEIF grid exceeds the ${MAX_HEIF_GRID_TILES}-tile safety limit.`);
    }
    safetyDimensions.push(grid);
    const tileIds = derivedReferences.get(gridItemId);
    if (!tileIds || tileIds.length !== grid.tileCount) {
      throw invalidHeader("The HEIC/HEIF grid tile count is ambiguous.");
    }
    for (const tileId of tileIds) {
      if (itemTypes.get(tileId) !== "hvc1" || !validatedHvcItems.has(tileId)) {
        throw invalidHeader("The HEIC/HEIF grid references an unbounded tile.");
      }
    }
    validatedGridItems.add(gridItemId);
  }

  if (primaryItemType === "hvc1") {
    if (!validatedHvcItems.has(primaryItemId)) throw invalidHeader();
  } else if (primaryItemType === "grid") {
    if (!validatedGridItems.has(primaryItemId)) throw invalidHeader();
  } else {
    throw invalidHeader(`The primary HEIC/HEIF item type ${primaryItemType} is unsupported.`);
  }

  return {
    format: "heif",
    ...primaryDimensions,
    decodedDimensions: [primaryDimensions],
    safetyDimensions: uniqueDimensions(safetyDimensions),
    aggregateDecodedPixels,
  };
}

/**
 * Retains at most 256 KiB of header-table reads and skips declared payloads.
 * JPEG entropy is inspected once in a bounded 64 KiB streaming buffer, up to
 * the existing 15 MiB compressed-file cap. No browser decoder is invoked.
 */
export async function inspectImageHeader(
  blob: Blob,
  expectedFormat: SupportedImageFormat,
): Promise<InspectedImageHeader> {
  if (blob.size < 12) throw invalidHeader("The image header is truncated.");
  if (blob.size > MAX_IMAGE_FILE_BYTES) throw invalidHeader("The image exceeds the 15 MB inspection limit.");
  const reader = new BoundedBlobReader(blob);
  const prefix = await reader.read(0, 12);
  let inspected: InspectedImageHeader;
  if (PNG_SIGNATURE.every((byte, index) => prefix[index] === byte)) {
    inspected = await inspectPng(reader);
  } else if (prefix[0] === 0xff && prefix[1] === 0xd8) {
    inspected = await inspectJpeg(reader);
  } else if (ascii(prefix, 0, 4) === "RIFF" && ascii(prefix, 8, 4) === "WEBP") {
    inspected = await inspectWebp(reader);
  } else if (ascii(prefix, 4, 4) === "ftyp") {
    inspected = await inspectHeif(reader);
  } else {
    throw invalidHeader("The file contents are not a supported image.");
  }
  if (inspected.format !== expectedFormat) {
    throw invalidHeader("The image contents do not match its declared file type.");
  }
  return inspected;
}

export function decodedDimensionsMatchHeader(
  header: InspectedImageHeader,
  width: number,
  height: number,
): boolean {
  return header.decodedDimensions.some(
    (candidate) =>
      (candidate.width === width && candidate.height === height) ||
      (candidate.width === height && candidate.height === width),
  );
}

export function imageExceedsPixelLimit(
  value: ImageDimensions | InspectedImageHeader,
  maxPixels: number,
): boolean {
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) return true;
  const candidates = "safetyDimensions" in value ? value.safetyDimensions : [value];
  if (
    candidates.some(
      (candidate) => BigInt(candidate.width) * BigInt(candidate.height) > BigInt(maxPixels),
    )
  ) {
    return true;
  }
  return "aggregateDecodedPixels" in value && value.aggregateDecodedPixels > BigInt(maxPixels);
}

export function imageExceedsDimensionLimit(
  value: ImageDimensions | InspectedImageHeader,
  maxDimension = MAX_SAFE_IMAGE_DIMENSION,
): boolean {
  const candidates = "safetyDimensions" in value ? value.safetyDimensions : [value];
  return candidates.some(
    (candidate) => candidate.width > maxDimension || candidate.height > maxDimension,
  );
}
