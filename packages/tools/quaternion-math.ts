/**
 * Quaternion utility class for arithmetic, rotation, and interpolation.
 */
export class Quaternion {
  w: number;
  x: number;
  y: number;
  z: number;

  /**
   * Create a quaternion.
   * @param w - Scalar component
   * @param x - X component
   * @param y - Y component
   * @param z - Z component
   */
  constructor(w: number, x: number, y: number, z: number) {
    this.w = w;
    this.x = x;
    this.y = y;
    this.z = z;
  }

  /**
   * Multiply this quaternion by another.
   * @param other - Other quaternion
   * @returns Resulting quaternion
   */
  multiply(other: Quaternion): Quaternion {
    return new Quaternion(
      this.w * other.w - this.x * other.x - this.y * other.y - this.z * other.z,
      this.w * other.x + this.x * other.w + this.y * other.z - this.z * other.y,
      this.w * other.y - this.x * other.z + this.y * other.w + this.z * other.x,
      this.w * other.z + this.x * other.y - this.y * other.x + this.z * other.w
    );
  }

  /**
   * Compute the conjugate of this quaternion.
   * @returns Conjugate quaternion
   */
  conjugate(): Quaternion {
    return new Quaternion(this.w, -this.x, -this.y, -this.z);
  }

  /**
   * Compute the norm of this quaternion.
   * @returns Norm value
   */
  norm(): number {
    return Math.sqrt(this.w ** 2 + this.x ** 2 + this.y ** 2 + this.z ** 2);
  }

  /**
   * Compute the inverse of this quaternion.
   * @returns Inverse quaternion
   */
  inverse(): Quaternion {
    const n = this.norm() ** 2;
    return new Quaternion(this.w / n, -this.x / n, -this.y / n, -this.z / n);
  }

  /**
   * Create a rotation quaternion from axis-angle.
   * @param axis - Axis vector [x, y, z]
   * @param angle - Angle in radians
   * @returns Rotation quaternion
   */
  static fromAxisAngle(axis: [number, number, number], angle: number): Quaternion {
    const [x, y, z] = axis;
    const norm = Math.sqrt(x ** 2 + y ** 2 + z ** 2);
    const s = Math.sin(angle / 2) / (norm || 1);
    return new Quaternion(Math.cos(angle / 2), x * s, y * s, z * s);
  }

  /**
   * Create a rotation quaternion from Euler angles (roll, pitch, yaw).
   * @param roll - Roll angle in radians
   * @param pitch - Pitch angle in radians
   * @param yaw - Yaw angle in radians
   * @returns Rotation quaternion
   */
  static fromEuler(roll: number, pitch: number, yaw: number): Quaternion {
    const qx = Quaternion.fromAxisAngle([1, 0, 0], roll);
    const qy = Quaternion.fromAxisAngle([0, 1, 0], pitch);
    const qz = Quaternion.fromAxisAngle([0, 0, 1], yaw);
    return qx.multiply(qy).multiply(qz);
  }

  /**
   * Apply rotation to a 3D vector.
   * @param vector - Vector [x, y, z]
   * @returns Rotated vector
   */
  applyVector(vector: [number, number, number]): [number, number, number] {
    const [x, y, z] = vector;
    const qv = new Quaternion(0, x, y, z);
    const q = this.multiply(qv).multiply(this.conjugate());
    return [q.x, q.y, q.z];
  }

  /**
   * Spherical linear interpolation between two quaternions.
   * @param a - First quaternion
   * @param b - Second quaternion
   * @param t - Interpolation factor [0, 1]
   * @returns Interpolated quaternion
   */
  static slerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
    const dot = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
    const sign = dot < 0 ? -1 : 1;
    const angle = Math.acos(Math.max(Math.min(sign * dot, 1), -1));
    const s = Math.sin(angle);
    const invS = 1 / s;
    const w = (Math.sin((1 - t) * angle) * invS) / 2 + (Math.sin(t * angle) * invS) / 2;
    const x = (Math.sin((1 - t) * angle) * a.x * invS + Math.sin(t * angle) * b.x * invS) / 2;
    const y = (Math.sin((1 - t) * angle) * a.y * invS + Math.sin(t * angle) * b.y * invS) / 2;
    const z = (Math.sin((1 - t) * angle) * a.z * invS + Math.sin(t * angle) * b.z * invS) / 2;
    return new Quaternion(w, x, y, z);
  }
}