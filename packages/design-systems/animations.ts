/**
 * Animation Reference Library for 8gent
 *
 * Comprehensive animation patterns, easing curves, and motion principles.
 * Consulted before any UI with motion is built.
 *
 * Sources: Apple HIG, Material Design Motion, Framer Motion best practices,
 * Remotion composition patterns, WebGL/WASM performance guides.
 */

// ============================================
// PRINCIPLES (Apple-level motion design)
// ============================================

export const MOTION_PRINCIPLES = {
  // 1. Motion should feel natural, not mechanical
  naturalMotion: {
    rule: "Use spring physics or custom bezier curves, never linear timing for UI elements",
    why: "Linear motion feels robotic. Springs feel alive.",
  },

  // 2. Everything has weight
  physicality: {
    rule: "Heavier elements move slower. Lighter elements move faster. Large panels ease in gently. Small buttons snap.",
    why: "Mass implies importance. Quick = light. Slow = heavy.",
  },

  // 3. Motion creates hierarchy
  hierarchy: {
    rule: "Primary content animates first. Secondary content follows with staggered delay (50-100ms between items).",
    why: "Stagger guides the eye. It tells the user what to look at first.",
  },

  // 4. Exit is faster than enter
  asymmetry: {
    rule: "Enter animations: 300-500ms. Exit animations: 150-250ms. Users don't want to wait for things to leave.",
    why: "Slow exits feel sluggish. The user already decided to dismiss - honor that.",
  },

  // 5. Less is more
  restraint: {
    rule: "If removing the animation doesn't hurt comprehension, remove it. Every animation must earn its milliseconds.",
    why: "Animation tax: each motion adds cognitive load. Pay only when it buys clarity.",
  },

  // 6. Respect the user
  accessibility: {
    rule: "Always check prefers-reduced-motion. Provide instant alternatives. Never gate content behind animation.",
    why: "Some users get motion sick. Some have vestibular disorders. Motion is enhancement, not requirement.",
  },
};

// ============================================
// EASING CURVES
// ============================================

export const EASING = {
  // Standard curves (use these 90% of the time)
  standard: {
    css: "cubic-bezier(0.4, 0.0, 0.2, 1)",
    description: "Default for most transitions. Starts fast, ends smooth.",
    use: "Page transitions, card reveals, container resizing",
  },
  decelerate: {
    css: "cubic-bezier(0.0, 0.0, 0.2, 1)",
    description: "Elements entering the screen. Starts fast, slows to stop.",
    use: "Modals appearing, toasts sliding in, elements fading in",
  },
  accelerate: {
    css: "cubic-bezier(0.4, 0.0, 1, 1)",
    description: "Elements leaving the screen. Starts slow, accelerates out.",
    use: "Dismissing modals, removing cards, sliding elements off-screen",
  },

  // Apple-specific curves
  appleSpring: {
    css: "cubic-bezier(0.25, 0.1, 0.25, 1.0)",
    description: "Apple's default spring-like feel. Slight overshoot.",
    use: "iOS-style interactions, toggle switches, button presses",
  },
  appleBounce: {
    css: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    description: "Playful overshoot. Use sparingly.",
    use: "Notification badges, success checkmarks, celebratory moments",
  },

  // Framer Motion springs (preferred over CSS bezier when possible)
  spring: {
    gentle: { stiffness: 120, damping: 14, mass: 1 },
    snappy: { stiffness: 300, damping: 30, mass: 1 },
    bouncy: { stiffness: 400, damping: 10, mass: 1 },
    slow: { stiffness: 60, damping: 20, mass: 1 },
  },

  // Scroll-linked (no easing - position-driven)
  scroll: {
    description: "For scroll-driven animations, use linear mapping from scroll position to property value. No easing curve needed.",
    use: "Parallax, progress indicators, sticky headers, reveal on scroll",
  },
};

// ============================================
// DURATION GUIDE
// ============================================

export const DURATION = {
  // By element size
  micro: { ms: 100, use: "Button press feedback, checkbox toggle, ripple" },
  small: { ms: 200, use: "Tooltip appear, dropdown open, icon swap" },
  medium: { ms: 300, use: "Card flip, panel slide, modal appear" },
  large: { ms: 500, use: "Page transition, full-screen overlay, route change" },
  slow: { ms: 800, use: "Hero entrance, splash screen, onboarding step" },

  // Rules
  rules: [
    "Never exceed 1000ms for any UI animation. Users lose patience after 400ms.",
    "Stagger children by 50-80ms each. Never more than 100ms gap.",
    "Hover effects: 150ms max. Must feel instant.",
    "Loading skeletons: pulse at 1.5-2s cycle (ambient, not attention-grabbing).",
    "Scroll reveals: 400-600ms with 0.1 intersection threshold.",
  ],
};

// ============================================
// ANIMATION PATTERNS
// ============================================

export const PATTERNS = {

  // --- SCROLL ANIMATIONS ---

  fadeInUp: {
    description: "Element fades in while moving up 20-30px. The bread and butter of scroll reveal.",
    css: `
      .fade-in-up {
        opacity: 0;
        transform: translateY(24px);
        transition: opacity 0.6s cubic-bezier(0.4, 0, 0.2, 1),
                    transform 0.6s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .fade-in-up.visible {
        opacity: 1;
        transform: translateY(0);
      }
    `,
    framer: `
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
        viewport={{ once: true, margin: "-10%" }}
      />
    `,
    use: "Section reveals, card appearances, text blocks entering viewport",
  },

  staggerChildren: {
    description: "Children animate in sequence with delay between each. Creates a cascade effect.",
    framer: `
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true }}
        variants={{
          hidden: {},
          visible: { transition: { staggerChildren: 0.08 } }
        }}
      >
        {items.map(item => (
          <motion.div
            key={item.id}
            variants={{
              hidden: { opacity: 0, y: 20 },
              visible: { opacity: 1, y: 0, transition: { duration: 0.5 } }
            }}
          />
        ))}
      </motion.div>
    `,
    use: "Grid items, list items, spec cards, feature grids, pricing tiers",
  },

  parallax: {
    description: "Background moves slower than foreground, creating depth.",
    css: `
      .parallax-container {
        overflow: hidden;
        position: relative;
      }
      .parallax-bg {
        position: absolute;
        inset: -20%;
        will-change: transform;
      }
    `,
    js: `
      // Use IntersectionObserver + scroll position
      const handleScroll = () => {
        const scrolled = window.scrollY;
        element.style.transform = \`translateY(\${scrolled * 0.3}px)\`;
      };
    `,
    use: "Hero backgrounds, section dividers, product showcase images",
  },

  counterUp: {
    description: "Numbers count up from 0 to target value. Use requestAnimationFrame.",
    js: `
      function animateCounter(element, target, duration = 2000) {
        const start = performance.now();
        const update = (now) => {
          const progress = Math.min((now - start) / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
          element.textContent = Math.round(target * eased).toLocaleString();
          if (progress < 1) requestAnimationFrame(update);
        };
        requestAnimationFrame(update);
      }
    `,
    use: "Stats sections, dashboard numbers, benchmark scores",
  },

  // --- INTERACTION ANIMATIONS ---

  buttonPress: {
    description: "Subtle scale down on press, return on release. Feels physical.",
    css: `
      .btn {
        transition: transform 0.1s ease;
      }
      .btn:active {
        transform: scale(0.97);
      }
    `,
    framer: `
      <motion.button
        whileTap={{ scale: 0.97 }}
        transition={{ duration: 0.1 }}
      />
    `,
    use: "All clickable elements. Subtle but essential for tactile feel.",
  },

  hoverLift: {
    description: "Card lifts slightly on hover with increased shadow.",
    css: `
      .card {
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                    box-shadow 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .card:hover {
        transform: translateY(-4px);
        box-shadow: 0 12px 24px rgba(0,0,0,0.12);
      }
    `,
    use: "Cards, tiles, clickable containers",
  },

  magneticCursor: {
    description: "Element subtly follows cursor position within its bounds.",
    js: `
      element.addEventListener('mousemove', (e) => {
        const rect = element.getBoundingClientRect();
        const x = (e.clientX - rect.left - rect.width / 2) * 0.1;
        const y = (e.clientY - rect.top - rect.height / 2) * 0.1;
        element.style.transform = \`translate(\${x}px, \${y}px)\`;
      });
      element.addEventListener('mouseleave', () => {
        element.style.transform = 'translate(0, 0)';
      });
    `,
    use: "CTAs, hero buttons, interactive elements. Use sparingly.",
  },

  // --- PAGE TRANSITIONS ---

  crossfade: {
    description: "Old page fades out, new page fades in. Clean and simple.",
    framer: `
      <AnimatePresence mode="wait">
        <motion.div
          key={pathname}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        />
      </AnimatePresence>
    `,
    use: "Route transitions, tab switches, content swaps",
  },

  slideTransition: {
    description: "Content slides in from the direction of navigation.",
    framer: `
      <motion.div
        initial={{ x: direction === 'forward' ? 100 : -100, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: direction === 'forward' ? -100 : 100, opacity: 0 }}
        transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
      />
    `,
    use: "Multi-step forms, onboarding flows, carousel navigation",
  },

  // --- LOADING & SKELETON ---

  shimmer: {
    description: "Gradient sweep across skeleton placeholder. Ambient, not distracting.",
    css: `
      .skeleton {
        background: linear-gradient(90deg,
          #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%
        );
        background-size: 200% 100%;
        animation: shimmer 1.5s ease-in-out infinite;
      }
      @keyframes shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
    `,
    use: "Content loading states, image placeholders, text skeletons",
  },

  // --- TEXT ANIMATIONS ---

  typewriter: {
    description: "Characters appear one by one. Terminal aesthetic.",
    css: `
      .typewriter {
        overflow: hidden;
        white-space: nowrap;
        border-right: 2px solid;
        animation:
          typing 2s steps(30) forwards,
          blink 0.8s step-end infinite;
      }
      @keyframes typing { from { width: 0; } to { width: 100%; } }
      @keyframes blink { 50% { border-color: transparent; } }
    `,
    use: "Terminal mockups, hero taglines, code demonstrations",
  },

  splitTextReveal: {
    description: "Each word or character animates in independently. High-end feel.",
    framer: `
      {text.split(' ').map((word, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05, duration: 0.4 }}
          style={{ display: 'inline-block', marginRight: '0.3em' }}
        >
          {word}
        </motion.span>
      ))}
    `,
    use: "Hero headlines, section titles, impactful statements",
  },
};

// ============================================
// PERFORMANCE RULES
// ============================================

export const PERFORMANCE = {
  rules: [
    "Only animate transform and opacity. These are compositor-only properties (GPU-accelerated).",
    "Never animate width, height, margin, padding, top, left. These trigger layout recalculation.",
    "Use will-change sparingly. Apply it just before animation, remove after.",
    "For scroll-driven animations, use Intersection Observer, not scroll event listeners.",
    "Debounce resize handlers. Throttle mousemove handlers to 16ms (60fps).",
    "Use requestAnimationFrame for any JS-driven animation, never setInterval.",
    "Test on low-end devices. If it stutters on a 2019 phone, simplify it.",
    "Prefer CSS animations over JS for simple transitions. CSS runs on compositor thread.",
    "For complex sequences, use Framer Motion's variants system, not chained timeouts.",
    "Remotion: use interpolate() for frame-based animation, not CSS transitions.",
  ],

  compositorProperties: ["transform", "opacity", "filter", "clip-path"],
  layoutProperties: ["width", "height", "margin", "padding", "top", "left", "right", "bottom", "font-size"],

  webgl: {
    when: "Use WebGL (Three.js / React Three Fiber) only for: 3D product visualizations, particle systems, shader effects, or data visualizations that CSS cannot achieve.",
    avoid: "Do not use WebGL for text, buttons, cards, or anything CSS can handle. WebGL has a high initialization cost and kills mobile performance if misused.",
  },

  wasm: {
    when: "Use WASM for: image processing, audio analysis, physics simulations, or heavy computation that blocks the main thread.",
    avoid: "Do not use WASM for DOM manipulation, animation, or anything the browser already does well.",
  },
};

// ============================================
// REMOTION-SPECIFIC
// ============================================

export const REMOTION = {
  principles: [
    "Use interpolate() for all frame-based values. Never use CSS transitions in Remotion.",
    "Composition duration in frames, not seconds. fps * seconds = frames.",
    "Use spring() for natural motion within compositions.",
    "Sequence components for timeline-based choreography.",
    "AbsoluteFill for layering. z-index for depth order.",
  ],

  interpolateExample: `
    import { interpolate, useCurrentFrame } from 'remotion';

    const frame = useCurrentFrame();
    const opacity = interpolate(frame, [0, 30], [0, 1], {
      extrapolateRight: 'clamp',
    });
    const y = interpolate(frame, [0, 30], [40, 0], {
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.cubic),
    });
  `,
};

// ============================================
// QUICK REFERENCE: What to use when
// ============================================

export const QUICK_REFERENCE = {
  "scroll reveal": "fadeInUp with IntersectionObserver, once: true",
  "grid of items": "staggerChildren with 50-80ms delay",
  "hero entrance": "splitTextReveal for headline, fadeInUp for subtitle, 800ms total",
  "button feedback": "scale(0.97) on :active, 100ms",
  "card hover": "translateY(-4px) + shadow increase, 300ms",
  "page transition": "crossfade with AnimatePresence, 300ms",
  "loading state": "shimmer skeleton, 1.5s cycle",
  "number display": "counterUp with ease-out cubic, 2s",
  "terminal text": "typewriter with steps(), 2s",
  "modal appear": "fadeInUp + backdrop opacity, 300ms",
  "toast notification": "slide in from top/bottom, 200ms enter, 150ms exit",
  "tab switch": "crossfade content, 200ms",
  "accordion": "height auto with grid-template-rows trick, 300ms",
  "nav scroll": "backdrop-filter + shadow on scroll, 200ms transition",
};
