---
name: vercel-react
description: React and Next.js performance rules for 8gent web tasks. Apply when writing, reviewing, or refactoring React/Next.js code.
type: skill
---

# Vercel React Best Practices

Reference when writing Next.js components, data fetching, or reviewing bundles.

## Eliminating Waterfalls (CRITICAL)

- **Parallel fetches**: Use `Promise.all()` for independent async operations. Never chain `await` calls that don't depend on each other.
- **Start early, await late**: In API routes, kick off promises at the top, await at the point of use.
- **Suspense boundaries**: Wrap independent data-fetching components so they stream concurrently.
- **Partial dependencies**: Use `Promise.allSettled()` or structured parallel fetching when some calls depend on others.

```ts
// Wrong - waterfall
const user = await getUser(id);
const posts = await getPosts(id);

// Right - parallel
const [user, posts] = await Promise.all([getUser(id), getPosts(id)]);
```

## Bundle Size (CRITICAL)

- **No barrel imports**: Import directly from the module file, not `index.ts` re-exports.
- **Dynamic imports**: Use `next/dynamic` for heavy components (charts, editors, rich text).
- **Defer third-party**: Load analytics, logging, chat widgets after hydration (`useEffect` or `next/script` with `afterInteractive`).
- **Conditional loading**: Load a module only when the feature is activated, not at page load.
- **Preload on hover**: For critical paths, preload on `onMouseEnter` / `onFocus` for perceived speed.

## Server Components (default)

- **Server by default**: Every component is a Server Component unless it needs interactivity or browser APIs.
- **Client boundary at the leaf**: Push `'use client'` as deep as possible. Don't make a whole page client just for one button.
- **Minimize serialized props**: Only pass what the client component needs. Don't forward large objects.
- **`React.cache()`**: Deduplicate identical fetches within a single request.
- **`unstable_cache` / ISR**: Cache cross-request data at the Next.js layer. Use `revalidate` to control staleness.

## Re-render Optimization

- **Don't subscribe to state you only use in callbacks**: Read from refs or pass values into handlers instead.
- **Memoize expensive components**: `React.memo` + stable props. Only when profiling proves it helps.
- **Primitive deps in effects**: Destructure objects before listing as `useEffect` deps to avoid infinite loops.
- **Functional `setState`**: Use `setState(prev => ...)` for stable callbacks that don't close over stale state.
- **`startTransition`**: Wrap non-urgent state updates (search, filter) to keep input responsive.
- **Lazy state init**: Pass a function to `useState(() => expensiveInit())` — runs once, not on every render.

## Rendering Performance

- **Hoist static JSX**: Define JSX that never changes outside the component function.
- **`content-visibility`**: Apply to off-screen sections of long pages.
- **Animate SVG wrapper**: Animate a `<div>` wrapper, not the SVG element directly.
- **Ternary, not `&&`**: Use `condition ? <A /> : null` not `condition && <A />` to avoid rendering `0`.

## JavaScript Performance

- **`Map` for lookups**: Build a `Map` once for repeated O(1) access instead of repeated `Array.find`.
- **Early return**: Exit functions as soon as the answer is known.
- **Combine iterations**: One `reduce` over an array instead of chained `.filter().map()`.
- **Hoist RegExp**: Define `const RE = /pattern/` outside the function, not inside a loop.
- **Cache storage reads**: `const val = localStorage.getItem('key')` once, not on every access.

## Image Optimization

- Always use `next/image`. Never raw `<img>` for content images.
- Provide explicit `width` and `height` to prevent layout shift.
- Use `priority` on above-the-fold images. Use `loading="lazy"` (default) for everything else.
- Serve WebP/AVIF via Next.js image config.

## Checklist Before Shipping

- [ ] No sequential awaits for independent fetches
- [ ] Heavy components use `next/dynamic`
- [ ] No unnecessary `'use client'` at layout/page level
- [ ] Images use `next/image` with explicit dimensions
- [ ] ISR or `React.cache` applied to repeated fetches
- [ ] No barrel imports from component libraries
