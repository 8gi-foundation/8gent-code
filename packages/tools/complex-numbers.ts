/**
 * Represents a complex number with real and imaginary parts.
 */
export class Complex {
  real: number;
  imag: number;

  constructor(real: number, imag: number) {
    this.real = real;
    this.imag = imag;
  }
}

/**
 * Adds two complex numbers.
 * @param a First complex number
 * @param b Second complex number
 * @returns Sum of a and b
 */
export function add(a: Complex, b: Complex): Complex {
  return new Complex(a.real + b.real, a.imag + b.imag);
}

/**
 * Subtracts two complex numbers.
 * @param a First complex number
 * @param b Second complex number
 * @returns Difference of a and b
 */
export function subtract(a: Complex, b: Complex): Complex {
  return new Complex(a.real - b.real, a.imag - b.imag);
}

/**
 * Multiplies two complex numbers.
 * @param a First complex number
 * @param b Second complex number
 * @returns Product of a and b
 */
export function multiply(a: Complex, b: Complex): Complex {
  return new Complex(
    a.real * b.real - a.imag * b.imag,
    a.real * b.imag + a.imag * b.real
  );
}

/**
 * Divides two complex numbers.
 * @param a Dividend
 * @param b Divisor
 * @returns Quotient of a divided by b
 */
export function divide(a: Complex, b: Complex): Complex {
  const denom = b.real ** 2 + b.imag ** 2;
  return new Complex(
    (a.real * b.real + a.imag * b.imag) / denom,
    (a.imag * b.real - a.real * b.imag) / denom
  );
}

/**
 * Converts complex number to polar form.
 * @param c Complex number
 * @returns Object with r (modulus) and theta (argument)
 */
export function toPolar(c: Complex): { r: number; theta: number } {
  const r = Math.sqrt(c.real ** 2 + c.imag ** 2);
  const theta = Math.atan2(c.imag, c.real);
  return { r, theta };
}

/**
 * Converts polar form to complex number.
 * @param r Modulus
 * @param theta Argument
 * @returns Complex number
 */
export function toRect(r: number, theta: number): Complex {
  return new Complex(r * Math.cos(theta), r * Math.sin(theta));
}

/**
 * Computes nth roots of a complex number.
 * @param c Complex number
 * @param n Root degree
 * @returns Array of nth roots
 */
export function nthRoots(c: Complex, n: number): Complex[] {
  const { r, theta } = toPolar(c);
  const roots: Complex[] = [];
  const rootR = Math.pow(r, 1 / n);
  for (let k = 0; k < n; k++) {
    const angle = (theta + 2 * Math.PI * k) / n;
    roots.push(new Complex(rootR * Math.cos(angle), rootR * Math.sin(angle)));
  }
  return roots;
}

/**
 * Computes complex exponential.
 * @param c Complex number
 * @returns e^c
 */
export function exp(c: Complex): Complex {
  const eReal = Math.exp(c.real);
  return new Complex(
    eReal * Math.cos(c.imag),
    eReal * Math.sin(c.imag)
  );
}

/**
 * Computes natural logarithm of a complex number.
 * @param c Complex number
 * @returns ln(c)
 */
export function log(c: Complex): Complex {
  const { r, theta } = toPolar(c);
  return new Complex(Math.log(r), theta);
}

/**
 * Computes sine of a complex number.
 * @param c Complex number
 * @returns sin(c)
 */
export function sin(c: Complex): Complex {
  return new Complex(
    Math.sin(c.real) * Math.cosh(c.imag),
    Math.cos(c.real) * Math.sinh(c.imag)
  );
}

/**
 * Computes cosine of a complex number.
 * @param c Complex number
 * @returns cos(c)
 */
export function cos(c: Complex): Complex {
  return new Complex(
    Math.cos(c.real) * Math.cosh(c.imag),
    -Math.sin(c.real) * Math.sinh(c.imag)
  );
}

/**
 * Computes tangent of a complex number.
 * @param c Complex number
 * @returns tan(c)
 */
export function tan(c: Complex): Complex {
  const sinVal = sin(c);
  const cosVal = cos(c);
  return divide(sinVal, cosVal);
}