import { getElementBounds } from "./geometry.js";
import type { Bounds, SceneElement } from "./types.js";

const DEFAULT_CELL_SIZE = 512;
const MAX_CELLS_PER_ELEMENT = 4_096;

function intersects(a: Bounds, b: Bounds): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY;
}

function cellRange(bounds: Bounds, cellSize: number): readonly [number, number, number, number] {
  return [
    Math.floor(bounds.minX / cellSize),
    Math.floor(bounds.maxX / cellSize),
    Math.floor(bounds.minY / cellSize),
    Math.floor(bounds.maxY / cellSize),
  ];
}

function cellKeys(bounds: Bounds, cellSize: number): readonly string[] | null {
  const [minX, maxX, minY, maxY] = cellRange(bounds, cellSize);
  const columns = maxX - minX + 1;
  const rows = maxY - minY + 1;
  if (columns * rows > MAX_CELLS_PER_ELEMENT) return null;
  const keys: string[] = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) keys.push(`${x}:${y}`);
  }
  return keys;
}

interface IndexedElement {
  element: SceneElement;
  bounds: Bounds;
  cellKeys: readonly string[] | null;
  order: number;
}

/** A paint-order-preserving incremental grid index for large infinite boards. */
export class ElementSpatialIndex {
  readonly #records = new Map<string, IndexedElement>();
  readonly #cells = new Map<string, Set<string>>();
  readonly #oversized = new Set<string>();
  readonly #cellSize: number;
  #elements: readonly SceneElement[] | null = null;

  constructor(elements: readonly SceneElement[], cellSize = DEFAULT_CELL_SIZE) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new TypeError("cellSize must be positive");
    this.#cellSize = cellSize;
    this.update(elements);
  }

  update(elements: readonly SceneElement[]): void {
    if (elements === this.#elements) return;
    const nextIds = new Set<string>();
    elements.forEach((element, order) => {
      if (nextIds.has(element.id)) throw new Error(`Duplicate drawing element ID: ${element.id}`);
      nextIds.add(element.id);
      const previous = this.#records.get(element.id);
      if (previous?.element === element) {
        previous.order = order;
        return;
      }
      if (previous) this.#remove(previous, element.id);
      const bounds = getElementBounds(element);
      const keys = cellKeys(bounds, this.#cellSize);
      const record: IndexedElement = { element, bounds, cellKeys: keys, order };
      this.#records.set(element.id, record);
      if (keys === null) {
        this.#oversized.add(element.id);
      } else {
        for (const key of keys) {
          const bucket = this.#cells.get(key);
          if (bucket) bucket.add(element.id);
          else this.#cells.set(key, new Set([element.id]));
        }
      }
    });
    for (const [id, record] of this.#records) {
      if (!nextIds.has(id)) this.#remove(record, id);
    }
    this.#elements = elements;
  }

  query(bounds: Bounds): readonly SceneElement[] {
    const [minX, maxX, minY, maxY] = cellRange(bounds, this.#cellSize);
    const candidates = new Set<string>(this.#oversized);
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (const id of this.#cells.get(`${x}:${y}`) ?? []) candidates.add(id);
      }
    }
    return [...candidates]
      .map((id) => this.#records.get(id))
      .filter((record): record is IndexedElement => record !== undefined)
      .filter((record) => intersects(record.bounds, bounds))
      .sort((left, right) => left.order - right.order)
      .map((record) => record.element);
  }

  #remove(record: IndexedElement, id: string): void {
    this.#records.delete(id);
    this.#oversized.delete(id);
    for (const key of record.cellKeys ?? []) {
      const bucket = this.#cells.get(key);
      bucket?.delete(id);
      if (bucket?.size === 0) this.#cells.delete(key);
    }
  }
}
