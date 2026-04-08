/**
 * 2D transformation matrix represented as a, b, c, d, tx, ty.
 */
export class Matrix2D {
  /**
   * @param a - scaleX
   * @param b - shearY
   * @param c - shearX
   * @param d - scaleY
   * @param tx - translateX
   * @param ty - translateY
   */
  constructor(
    public a: number,
    public b: number,
    public c: number,
    public d: number,
    public tx: number,
    public ty: number
  ) {}
}

/**
 * Multiplies two 2D matrices.
 * @param m1 - First matrix
 * @param m2 - Second matrix
 * @returns Resulting matrix
 */
export function multiply(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  return new Matrix2D(
    m1.a * m2.a + m1.b * m2.c,
    m1.a * m2.b + m1.b * m2.d,
    m1.c * m2.a + m1.d * m2.c,
    m1.c * m2.b + m1.d * m2.d,
    m1.tx * m2.a + m1.ty * m2.c + m2.tx,
    m1.tx * m2.b + m1.ty * m2.d + m2.ty
  );
}

/**
 * Creates a translation matrix.
 * @param tx - X translation
 * @param ty - Y translation
 * @returns Translation matrix
 */
export function translate(tx: number, ty: number): Matrix2D {
  return new Matrix2D(1, 0, 0, 1, tx, ty);
}

/**
 * Creates a rotation matrix.
 * @param angle - Rotation angle in radians
 * @returns Rotation matrix
 */
export function rotate(angle: number): Matrix2D {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return new Matrix2D(cos, -sin, sin, cos, 0, 0);
}

/**
 * Creates a scale matrix.
 * @param sx - X scale
 * @param sy - Y scale
 * @returns Scale matrix
 */
export function scale(sx: number, sy: number): Matrix2D {
  return new Matrix2D(sx, 0, 0, sy, 0, 0);
}

/**
 * Inverts a 2D matrix.
 * @param m - Matrix to invert
 * @returns Inverse matrix
 * @throws Error if matrix is not invertible
 */
export function invert(m: Matrix2D): Matrix2D {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) throw new Error('Matrix is not invertible');
  return new Matrix2D(
    m.d / det,
    -m.b / det,
    -m.c / det,
    m.a / det,
    (m.ty * m.b - m.tx * m.d) / det,
    (m.tx * m.c - m.ty * m.a) / det
  );
}

/**
 * Applies matrix transformation to a point.
 * @param m - Transformation matrix
 * @param x - X coordinate
 * @param y - Y coordinate
 * @returns Transformed coordinates [x, y]
 */
export function transformPoint(m: Matrix2D, x: number, y: number): [number, number] {
  return [
    m.a * x + m.c * y + m.tx,
    m.b * x + m.d * y + m.ty
  ];
}