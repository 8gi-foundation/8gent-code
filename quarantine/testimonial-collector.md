# testimonial-collector

Structures and scores customer testimonials for use in marketing and sales collateral.

## Requirements
- addTestimonial(pool, { author, role, company, text, rating, date })
- score(testimonial): 0-100 quality score based on specificity, length, role seniority
- topTestimonials(pool, n): returns best-scoring testimonials
- renderCard(testimonial): formatted testimonial card
- filterByIndustry(pool, industry): returns relevant testimonials

## Status

Quarantine - pending review.

## Location

`packages/tools/testimonial-collector.ts`
