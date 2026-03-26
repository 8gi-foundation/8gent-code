/**
 * Testimonial structure
 */
export interface Testimonial {
  author: string;
  role: string;
  company: string;
  text: string;
  rating: number;
  date: string;
  score: number;
}

/**
 * Adds a testimonial to the pool
 * @param pool - Testimonial array
 * @param data - Testimonial data
 */
export function addTestimonial(pool: Testimonial[], { author, role, company, text, rating, date }: Omit<Testimonial, 'score'>): void {
  pool.push({ ...{ author, role, company, text, rating, date }, score: 0 });
}

/**
 * Scores a testimonial based on text length, role seniority, and specificity
 * @param testimonial - Testimonial to score
 * @returns Score between 0-100
 */
export function score(testimonial: Testimonial): number {
  let s = 50;
  if (testimonial.text.length > 100) s += 20;
  else if (testimonial.text.length > 50) s += 10;
  if (['VP', 'Director', 'CFO', 'CEO', 'CTO'].some(r => testimonial.role.includes(r))) s += 15;
  if (['specific', 'detail', 'implementation'].some(w => testimonial.text.toLowerCase().includes(w))) s += 10;
  return Math.min(100, s);
}

/**
 * Returns top n testimonials by score
 * @param pool - Testimonial array
 * @param n - Number of testimonials
 * @returns Sorted array
 */
export function topTestimonials(pool: Testimonial[], n: number): Testimonial[] {
  return [...pool].sort((a, b) => b.score - a.score).slice(0, n);
}

/**
 * Renders a testimonial card
 * @param testimonial - Testimonial to render
 * @returns Formatted card string
 */
export function renderCard(testimonial: Testimonial): string {
  return `## ${testimonial.author} (${testimonial.role} @ ${testimonial.company})\n\n${testimonial.text}\n\nRating: ${testimonial.rating}/5 | Date: ${testimonial.date}`;
}

/**
 * Filters testimonials by industry keyword
 * @param pool - Testimonial array
 * @param industry - Industry keyword
 * @returns Filtered array
 */
export function filterByIndustry(pool: Testimonial[], industry: string): Testimonial[] {
  return pool.filter(t => t.text.toLowerCase().includes(industry.toLowerCase()));
}