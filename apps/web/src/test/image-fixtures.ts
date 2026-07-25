type Bytes = Uint8Array<ArrayBuffer>;

function ascii(value: string): Bytes {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function uint32be(value: number): Bytes {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function uint32le(value: number): Bytes {
  return Uint8Array.of(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}

function uint24le(value: number): Bytes {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff);
}

function uint16be(value: number): Bytes {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function join(...parts: readonly Uint8Array<ArrayBufferLike>[]): Bytes {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function box(type: string, ...payload: readonly Uint8Array<ArrayBufferLike>[]): Bytes {
  const body = join(...payload);
  return join(uint32be(body.length + 8), ascii(type), body);
}

class TestBitWriter {
  private readonly bits: number[] = [];

  write(value: number, count: number): void {
    const encoded = BigInt(value);
    for (let shift = count - 1; shift >= 0; shift -= 1) {
      this.bits.push(Number((encoded >> BigInt(shift)) & 1n));
    }
  }

  unsignedExpGolomb(value: number): void {
    const encoded = value + 1;
    const leadingZeros = Math.floor(Math.log2(encoded));
    this.write(0, leadingZeros);
    this.write(encoded, leadingZeros + 1);
  }

  bytes(): Bytes {
    this.write(1, 1);
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    const result = new Uint8Array(this.bits.length / 8);
    for (let index = 0; index < this.bits.length; index += 1) {
      const byteIndex = index >> 3;
      result[byteIndex] = (result[byteIndex] ?? 0) | ((this.bits[index] ?? 0) << (7 - (index & 7)));
    }
    return result;
  }
}

function hevcConfiguration(
  width: number,
  height: number,
  codedWidth = width,
  codedHeight = height,
): Bytes {
  const spsBits = new TestBitWriter();
  spsBits.write(0, 4);
  spsBits.write(0, 3);
  spsBits.write(1, 1);
  spsBits.write(0, 2);
  spsBits.write(0, 1);
  spsBits.write(1, 5);
  spsBits.write(0, 32);
  spsBits.write(0, 48);
  spsBits.write(120, 8);
  spsBits.unsignedExpGolomb(0);
  spsBits.unsignedExpGolomb(1);
  spsBits.unsignedExpGolomb(codedWidth);
  spsBits.unsignedExpGolomb(codedHeight);
  if (codedWidth !== width || codedHeight !== height) {
    if ((codedWidth - width) % 2 !== 0 || (codedHeight - height) % 2 !== 0) {
      throw new Error("Synthetic HEVC crop offsets must align to 4:2:0 chroma units.");
    }
    spsBits.write(1, 1);
    spsBits.unsignedExpGolomb(0);
    spsBits.unsignedExpGolomb((codedWidth - width) / 2);
    spsBits.unsignedExpGolomb(0);
    spsBits.unsignedExpGolomb((codedHeight - height) / 2);
  } else {
    spsBits.write(0, 1);
  }
  const sps = join(Uint8Array.of(0x42, 0x01), spsBits.bytes());
  const configuration = new Uint8Array(23);
  configuration[0] = 1;
  configuration[21] = 3;
  configuration[22] = 1;
  return join(configuration, Uint8Array.of(0x21), uint16be(1), uint16be(sps.length), sps);
}

function hvcItemPayload(nalType = 19): Bytes {
  const nal = Uint8Array.of((nalType & 0x3f) << 1, 1);
  return join(uint32be(nal.length), nal);
}

function itemInfo(itemId: number, itemType: string): Bytes {
  return box(
    "infe",
    Uint8Array.of(2, 0, 0, 0),
    uint16be(itemId),
    uint16be(0),
    ascii(itemType),
    Uint8Array.of(0),
  );
}

function spatialProperty(width: number, height: number): Bytes {
  return box("ispe", Uint8Array.of(0, 0, 0, 0), uint32be(width), uint32be(height));
}

function pngChunk(type: string, payload = new Uint8Array()): Bytes {
  return join(uint32be(payload.length), ascii(type), payload, uint32be(0));
}

export function pngBytes(width: number, height: number): Bytes {
  return join(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", join(uint32be(width), uint32be(height), Uint8Array.of(8, 6, 0, 0, 0))),
    pngChunk("IDAT", Uint8Array.of(0)),
    pngChunk("IEND"),
  );
}

export function animatedPngBytes(width: number, height: number): Bytes {
  return join(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", join(uint32be(1), uint32be(1), Uint8Array.of(8, 6, 0, 0, 0))),
    pngChunk("acTL", join(uint32be(1), uint32be(0))),
    pngChunk("fcTL", join(uint32be(0), uint32be(width), uint32be(height), new Uint8Array(14))),
    pngChunk("IDAT", Uint8Array.of(0)),
    pngChunk("IEND"),
  );
}

export function jpegBytes(width: number, height: number): Bytes {
  const frame = join(
    Uint8Array.of(0xff, 0xc0, 0x00, 0x11, 0x08),
    Uint8Array.of((height >>> 8) & 0xff, height & 0xff),
    Uint8Array.of((width >>> 8) & 0xff, width & 0xff),
    Uint8Array.of(3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0),
  );
  const scan = Uint8Array.of(
    0xff, 0xda, 0x00, 0x0c, 0x03,
    0x01, 0x00, 0x02, 0x00, 0x03, 0x00,
    0x00, 0x3f, 0x00,
  );
  return join(Uint8Array.of(0xff, 0xd8), frame, scan, Uint8Array.of(0), Uint8Array.of(0xff, 0xd9));
}

export function jpegWithLateFrameBytes(
  first: { readonly width: number; readonly height: number },
  late: { readonly width: number; readonly height: number },
  entropyPaddingBytes = 0,
): Bytes {
  const initial = jpegBytes(first.width, first.height);
  const lateFrame = jpegBytes(late.width, late.height).slice(2, 21);
  return join(
    initial.slice(0, -2),
    new Uint8Array(entropyPaddingBytes),
    lateFrame,
    Uint8Array.of(0xff, 0xd9),
  );
}

export function webpLosslessBytes(width: number, height: number): Bytes {
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  const payload = Uint8Array.of(
    0x2f,
    encodedWidth & 0xff,
    ((encodedWidth >>> 8) & 0x3f) | ((encodedHeight & 0x03) << 6),
    (encodedHeight >>> 2) & 0xff,
    (encodedHeight >>> 10) & 0x0f,
  );
  const paddedPayload = join(payload, Uint8Array.of(0));
  const chunk = join(ascii("VP8L"), uint32le(payload.length), paddedPayload);
  return join(ascii("RIFF"), uint32le(4 + chunk.length), ascii("WEBP"), chunk);
}

export function animatedWebpBytes(
  canvasWidth: number,
  canvasHeight: number,
  frameWidth: number,
  frameHeight: number,
): Bytes {
  const extended = join(
    ascii("VP8X"),
    uint32le(10),
    Uint8Array.of(0x02, 0, 0, 0),
    uint24le(canvasWidth - 1),
    uint24le(canvasHeight - 1),
  );
  const framePayload = join(
    uint24le(0),
    uint24le(0),
    uint24le(frameWidth - 1),
    uint24le(frameHeight - 1),
    uint24le(0),
    Uint8Array.of(0),
  );
  const frame = join(ascii("ANMF"), uint32le(framePayload.length), framePayload);
  return join(
    ascii("RIFF"),
    uint32le(4 + extended.length + frame.length),
    ascii("WEBP"),
    extended,
    frame,
  );
}

export function heifBytes(
  width: number,
  height: number,
  decoy?: { readonly width: number; readonly height: number },
  codec: {
    readonly width: number;
    readonly height: number;
    readonly codedWidth?: number;
    readonly codedHeight?: number;
    readonly inBandNalType?: number;
  } = { width, height },
): Bytes {
  const ftyp = box(
    "ftyp",
    ascii("heic"),
    uint32be(0),
    ascii("mif1"),
    ascii("heic"),
  );
  const properties = decoy
    ? [spatialProperty(decoy.width, decoy.height), spatialProperty(width, height), box("hvcC", hevcConfiguration(codec.width, codec.height, codec.codedWidth, codec.codedHeight))]
    : [spatialProperty(width, height), box("hvcC", hevcConfiguration(codec.width, codec.height, codec.codedWidth, codec.codedHeight))];
  const spatialIndex = decoy ? 2 : 1;
  const codecIndex = decoy ? 3 : 2;
  const ipco = box("ipco", ...properties);
  const ipma = box(
    "ipma",
    Uint8Array.of(0, 0, 0, 0),
    uint32be(1),
    uint16be(1),
    Uint8Array.of(2, 0x80 | spatialIndex, 0x80 | codecIndex),
  );
  const iprp = box("iprp", ipco, ipma);
  const pitm = box("pitm", Uint8Array.of(0, 0, 0, 0), uint16be(1));
  const iinf = box(
    "iinf",
    Uint8Array.of(0, 0, 0, 0),
    uint16be(1),
    itemInfo(1, "hvc1"),
  );
  const itemPayload = hvcItemPayload(codec.inBandNalType);
  const iloc = box(
    "iloc",
    Uint8Array.of(1, 0, 0, 0, 0x44, 0),
    uint16be(1),
    uint16be(1),
    uint16be(1),
    uint16be(0),
    uint16be(1),
    uint32be(0),
    uint32be(itemPayload.length),
  );
  const idat = box("idat", itemPayload);
  const meta = box("meta", Uint8Array.of(0, 0, 0, 0), pitm, iinf, iprp, iloc, idat);
  return join(ftyp, meta);
}

export function heifGridBytes(
  width: number,
  height: number,
  descriptorWidth = width,
  descriptorHeight = height,
  options: {
    readonly rows?: number;
    readonly columns?: number;
    readonly tileWidth?: number;
    readonly tileHeight?: number;
  } = {},
): Bytes {
  const rows = options.rows ?? 1;
  const columns = options.columns ?? 1;
  const tileWidth = options.tileWidth ?? 512;
  const tileHeight = options.tileHeight ?? 512;
  const tileCount = rows * columns;
  const gridItemId = tileCount + 1;
  const tilePayload = hvcItemPayload();
  const ftyp = box("ftyp", ascii("heic"), uint32be(0), ascii("mif1"), ascii("heic"));
  const ipco = box(
    "ipco",
    spatialProperty(tileWidth, tileHeight),
    box("hvcC", hevcConfiguration(tileWidth, tileHeight)),
    spatialProperty(width, height),
  );
  const tileAssociations = Array.from({ length: tileCount }, (_, index) =>
    join(uint16be(index + 1), Uint8Array.of(2, 0x81, 0x82))
  );
  const ipma = box(
    "ipma",
    Uint8Array.of(0, 0, 0, 0),
    uint32be(tileCount + 1),
    ...tileAssociations,
    uint16be(gridItemId),
    Uint8Array.of(1, 0x83),
  );
  const iprp = box("iprp", ipco, ipma);
  const pitm = box("pitm", Uint8Array.of(0, 0, 0, 0), uint16be(gridItemId));
  const tileInfo = Array.from({ length: tileCount }, (_, index) => itemInfo(index + 1, "hvc1"));
  const iinf = box(
    "iinf",
    Uint8Array.of(0, 0, 0, 0),
    uint16be(tileCount + 1),
    ...tileInfo,
    itemInfo(gridItemId, "grid"),
  );
  const tileReferences = Array.from({ length: tileCount }, (_, index) => uint16be(index + 1));
  const iref = box(
    "iref",
    Uint8Array.of(0, 0, 0, 0),
    box("dimg", uint16be(gridItemId), uint16be(tileCount), ...tileReferences),
  );
  const wideGrid = descriptorWidth > 0xffff || descriptorHeight > 0xffff;
  const grid = join(
    Uint8Array.of(0, wideGrid ? 1 : 0, rows - 1, columns - 1),
    wideGrid ? uint32be(descriptorWidth) : uint16be(descriptorWidth),
    wideGrid ? uint32be(descriptorHeight) : uint16be(descriptorHeight),
  );
  const tileLocations = Array.from({ length: tileCount }, (_, index) =>
    join(
      uint16be(index + 1),
      uint16be(1),
      uint16be(0),
      uint16be(1),
      uint32be(index * tilePayload.length),
      uint32be(tilePayload.length),
    )
  );
  const iloc = box(
    "iloc",
    Uint8Array.of(1, 0, 0, 0, 0x44, 0),
    uint16be(tileCount + 1),
    ...tileLocations,
    uint16be(gridItemId),
    uint16be(1),
    uint16be(0),
    uint16be(1),
    uint32be(tileCount * tilePayload.length),
    uint32be(grid.length),
  );
  const tilePayloads = Array.from({ length: tileCount }, () => tilePayload);
  const idat = box("idat", ...tilePayloads, grid);
  const meta = box("meta", Uint8Array.of(0, 0, 0, 0), pitm, iinf, iref, iprp, iloc, idat);
  return join(ftyp, meta);
}

export function heifAuxiliaryGridBytes(
  primaryWidth: number,
  primaryHeight: number,
  auxiliaryWidth: number,
  auxiliaryHeight: number,
  auxiliaryDescriptorWidth = auxiliaryWidth,
  auxiliaryDescriptorHeight = auxiliaryHeight,
): Bytes {
  const ftyp = box("ftyp", ascii("heic"), uint32be(0), ascii("mif1"), ascii("heic"));
  const tilePayload = hvcItemPayload();
  const primaryGrid = join(Uint8Array.of(0, 0, 0, 0), uint16be(primaryWidth), uint16be(primaryHeight));
  const wideAuxiliary = auxiliaryDescriptorWidth > 0xffff || auxiliaryDescriptorHeight > 0xffff;
  const auxiliaryGrid = join(
    Uint8Array.of(0, wideAuxiliary ? 1 : 0, 0, 0),
    wideAuxiliary ? uint32be(auxiliaryDescriptorWidth) : uint16be(auxiliaryDescriptorWidth),
    wideAuxiliary ? uint32be(auxiliaryDescriptorHeight) : uint16be(auxiliaryDescriptorHeight),
  );
  const ipco = box(
    "ipco",
    spatialProperty(512, 512),
    box("hvcC", hevcConfiguration(512, 512)),
    spatialProperty(primaryWidth, primaryHeight),
    spatialProperty(auxiliaryWidth, auxiliaryHeight),
  );
  const ipma = box(
    "ipma",
    Uint8Array.of(0, 0, 0, 0),
    uint32be(4),
    uint16be(1), Uint8Array.of(2, 0x81, 0x82),
    uint16be(2), Uint8Array.of(2, 0x81, 0x82),
    uint16be(3), Uint8Array.of(1, 0x83),
    uint16be(4), Uint8Array.of(1, 0x84),
  );
  const iprp = box("iprp", ipco, ipma);
  const pitm = box("pitm", Uint8Array.of(0, 0, 0, 0), uint16be(3));
  const iinf = box(
    "iinf",
    Uint8Array.of(0, 0, 0, 0),
    uint16be(4),
    itemInfo(1, "hvc1"),
    itemInfo(2, "hvc1"),
    itemInfo(3, "grid"),
    itemInfo(4, "grid"),
  );
  const iref = box(
    "iref",
    Uint8Array.of(0, 0, 0, 0),
    box("dimg", uint16be(3), uint16be(1), uint16be(1)),
    box("dimg", uint16be(4), uint16be(1), uint16be(2)),
  );
  const offsets = [
    { itemId: 1, offset: 0, length: tilePayload.length },
    { itemId: 2, offset: tilePayload.length, length: tilePayload.length },
    { itemId: 3, offset: tilePayload.length * 2, length: primaryGrid.length },
    { itemId: 4, offset: tilePayload.length * 2 + primaryGrid.length, length: auxiliaryGrid.length },
  ];
  const locations = offsets.map(({ itemId, offset, length }) =>
    join(
      uint16be(itemId),
      uint16be(1),
      uint16be(0),
      uint16be(1),
      uint32be(offset),
      uint32be(length),
    )
  );
  const iloc = box(
    "iloc",
    Uint8Array.of(1, 0, 0, 0, 0x44, 0),
    uint16be(4),
    ...locations,
  );
  const idat = box("idat", tilePayload, tilePayload, primaryGrid, auxiliaryGrid);
  const meta = box("meta", Uint8Array.of(0, 0, 0, 0), pitm, iinf, iref, iprp, iloc, idat);
  return join(ftyp, meta);
}
