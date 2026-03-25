/**
 * Matrix2D - 2D transformation matrix for graphics and layout.
 *
 * Represents an affine transform as a 3x3 matrix stored as:
 *   [ a  c  e ]
 *   [ b  d  f ]
 *   [ 0  0  1 ]
 *
 * Compatible with CSS matrix(a,b,c,d,e,f) notation.
 * All operations return new instances - the class is immutable.
 */

export type MatrixValues = [number, number, number, number, number, number];
export type Point = { x: number; y: number };
export type Decomposed = {
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  rotation: number; // radians
  skewX: number;   // radians
};

export class Matrix2D {
  // [a, b, c, d, e, f] - matches CSS matrix(a,b,c,d,e,f)
  private m: MatrixValues;

  private constructor(values: MatrixValues) {
    this.m = [...values] as MatrixValues;
  }

  // --- Factories ---

  static identity(): Matrix2D {
    return new Matrix2D([1, 0, 0, 1, 0, 0]);
  }

  static fromValues(a: number, b: number, c: number, d: number, e: number, f: number): Matrix2D {
    return new Matrix2D([a, b, c, d, e, f]);
  }

  // --- Operations (immutable - each returns a new Matrix2D) ---

  multiply(other: Matrix2D): Matrix2D {
    const [a1, b1, c1, d1, e1, f1] = this.m;
    const [a2, b2, c2, d2, e2, f2] = other.m;
    return new Matrix2D([
      a1 * a2 + c1 * b2,
      b1 * a2 + d1 * b2,
      a1 * c2 + c1 * d2,
      b1 * c2 + d1 * d2,
      a1 * e2 + c1 * f2 + e1,
      b1 * e2 + d1 * f2 + f1,
    ]);
  }

  translate(tx: number, ty: number): Matrix2D {
    return this.multiply(new Matrix2D([1, 0, 0, 1, tx, ty]));
  }

  scale(sx: number, sy: number = sx): Matrix2D {
    return this.multiply(new Matrix2D([sx, 0, 0, sy, 0, 0]));
  }

  rotate(angle: number): Matrix2D {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return this.multiply(new Matrix2D([cos, sin, -sin, cos, 0, 0]));
  }

  skew(ax: number, ay: number = 0): Matrix2D {
    return this.multiply(new Matrix2D([1, Math.tan(ay), Math.tan(ax), 1, 0, 0]));
  }

  inverse(): Matrix2D {
    const [a, b, c, d, e, f] = this.m;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-10) {
      throw new Error("Matrix2D: matrix is not invertible (determinant is zero)");
    }
    const inv = 1 / det;
    return new Matrix2D([
      d * inv,
      -b * inv,
      -c * inv,
      a * inv,
      (c * f - d * e) * inv,
      (b * e - a * f) * inv,
    ]);
  }

  // --- Point transform ---

  transformPoint(p: Point): Point {
    const [a, b, c, d, e, f] = this.m;
    return {
      x: a * p.x + c * p.y + e,
      y: b * p.x + d * p.y + f,
    };
  }

  // --- Introspection ---

  values(): MatrixValues {
    return [...this.m] as MatrixValues;
  }

  determinant(): number {
    const [a, b, c, d] = this.m;
    return a * d - b * c;
  }

  isIdentity(): boolean {
    const [a, b, c, d, e, f] = this.m;
    return a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0;
  }

  /** Decompose into translate, scale, rotation, and skew components. */
  decompose(): Decomposed {
    const [a, b, c, d, e, f] = this.m;
    const scaleX = Math.sqrt(a * a + b * b);
    const scaleY = Math.sqrt(c * c + d * d);
    const rotation = Math.atan2(b, a);
    const skewX = Math.atan2(a * c + b * d, scaleX * scaleY);
    return {
      translateX: e,
      translateY: f,
      scaleX,
      scaleY: (a * d - b * c) < 0 ? -scaleY : scaleY,
      rotation,
      skewX,
    };
  }

  // --- CSS output ---

  /** Returns CSS matrix(a,b,c,d,e,f) string. */
  toCSS(): string {
    return `matrix(${this.m.map((v) => +v.toFixed(6)).join(",")})`;
  }

  /** Returns CSS matrix3d() string for 3D compositing layers. */
  toCSS3d(): string {
    const [a, b, c, d, e, f] = this.m;
    return `matrix3d(${a},${b},0,0,${c},${d},0,0,0,0,1,0,${e},${f},0,1)`;
  }

  toString(): string {
    return this.toCSS();
  }
}
