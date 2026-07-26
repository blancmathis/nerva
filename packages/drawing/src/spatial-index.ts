import { getElementBounds } from "./geometry.js";
import type { Bounds, SceneElement } from "./types.js";

const DEFAULT_CELL_SIZE = 512;

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

/** A paint-order-preserving grid index for viewport culling on large boards. */
export class ElementSpatialIndex {
  readonly #elements: readonly SceneElement[];
  readonly #bounds: readonly Bounds[];
  readonly #cells = new Map<string, number[]>();
  readonly #cellSize: number;

  constructor(elements: readonly SceneElement[], cellSize = DEFAULT_CELL_SIZE) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new TypeError("cellSize must be positive");
    this.#elements = elements;
    this.#cellSize = cellSize;
    this.#bounds = elements.map(getElementBounds);
    this.#bounds.forEach((bounds, index) => {
      const [minX, maxX, minY, maxY] = cellRange(bounds, cellSize);
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          const key = `${x}:${y}`;
          const bucket = this.#cells.get(key);
          if (bucket) bucket.push(index);
          else this.#cells.set(key, [index]);
        }
      }
    });
  }

  query(bounds: Bounds): readonly SceneElement[] {
    const [minX, maxX, minY, maxY] = cellRange(bounds, this.#cellSize);
    const candidates = new Set<number>();
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (const index of this.#cells.get(`${x}:${y}`) ?? []) candidates.add(index);
      }
    }
    return [...candidates]
      .sort((left, right) => left - right)
      .filter((index) => intersects(this.#bounds[index]!, bounds))
      .map((index) => this.#elements[index]!);
  }
}
