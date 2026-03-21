/**
 * Radiant Visual Patterns Reference
 *
 * Extracted from https://github.com/PodJamz/radiant.git
 * Radiant is an open-source collection of 94 production-ready shaders and
 * visual effects for the web, built with SvelteKit 5, Canvas 2D, and WebGL.
 * Created by Paul Bakaus, MIT licensed.
 *
 * This file captures every visual pattern, color scheme, layout technique,
 * animation, component pattern, and typography decision from the Radiant
 * gallery and its shader collection. Use it as a reference when building
 * premium dark-themed websites, shader galleries, creative portfolios,
 * or any site that needs cinematic, ambient visual quality.
 *
 * Categories:
 *   1. COLOR_PATTERNS - Gradients, palettes, opacity treatments, color schemes
 *   2. LAYOUT_PATTERNS - Grids, spacing, responsive breakpoints, page structures
 *   3. ANIMATION_PATTERNS - Keyframes, transitions, scroll effects, shader techniques
 *   4. COMPONENT_PATTERNS - Cards, buttons, heroes, sidebars, navigation
 *   5. TYPOGRAPHY_PATTERNS - Font stacks, sizes, weights, letter-spacing
 *   6. VISUAL_EFFECTS - Blurs, shadows, borders, overlays, filters
 *   7. RESPONSIVE_PATTERNS - Mobile, tablet, desktop breakpoints
 *   8. SHADER_CATALOG - All 94 shaders with descriptions and parameter signatures
 *   9. INSPIRATION_PALETTES - Artist-themed color palettes for mood-driven design
 */

// ============================================
// 1. COLOR PATTERNS
// ============================================

export const COLOR_PATTERNS = {
  // -- Core palette (Amber/Dark theme) --
  corePalette: {
    background: '#0a0a0a',
    backgroundElevated: '#0f0f0f',
    backgroundCard: '#111',
    backgroundPanel: '#0d0d0d',
    textPrimary: '#e8e0d8',
    textSecondary: 'rgba(232, 224, 216, 0.7)',
    textMuted: 'rgba(232, 224, 216, 0.5)',
    textSubtle: 'rgba(232, 224, 216, 0.45)',
    textFaint: 'rgba(232, 224, 216, 0.35)',
    textGhost: 'rgba(232, 224, 216, 0.3)',
    textDisabled: 'rgba(232, 224, 216, 0.25)',
    accent: '#c8956c',
    accentHover: '#d4a57c',
    accentMuted: 'rgba(200, 149, 108, 0.5)',
    accentSubtle: 'rgba(200, 149, 108, 0.4)',
    accentFaint: 'rgba(200, 149, 108, 0.15)',
    accentGhost: 'rgba(200, 149, 108, 0.12)',
    accentBorder: 'rgba(200, 149, 108, 0.1)',
    liveIndicator: '#dc3c3c',
    description: 'Warm amber on near-black. The accent (#c8956c) is a golden-brown that reads as luxurious and creative. Text uses warm off-white (#e8e0d8) with rgba opacity layers for hierarchy.',
  },

  // -- Color scheme system (CSS filter-based, applied to iframes) --
  colorSchemes: [
    {
      id: 'amber',
      name: 'Amber',
      swatch: '#c8956c',
      filter: 'none',
      description: 'Default warm golden-brown. No filter applied.',
    },
    {
      id: 'monochrome',
      name: 'Mono',
      swatch: '#999',
      filter: 'grayscale(1)',
      description: 'Full desaturation. Elegant, editorial feel.',
    },
    {
      id: 'blue',
      name: 'Blue',
      swatch: '#6c8ec8',
      filter: 'hue-rotate(175deg)',
      description: 'Cool blue shift. Techy, calm, deep.',
    },
    {
      id: 'rose',
      name: 'Rose',
      swatch: '#c86c8e',
      filter: 'hue-rotate(300deg) saturate(1.1)',
      description: 'Warm pink-rose. Romantic, feminine.',
    },
    {
      id: 'emerald',
      name: 'Emerald',
      swatch: '#6cc889',
      filter: 'hue-rotate(90deg) saturate(1.2)',
      description: 'Rich green. Natural, organic, growth.',
    },
    {
      id: 'arctic',
      name: 'Arctic',
      swatch: '#b8ccd8',
      filter: 'hue-rotate(180deg) saturate(0.5) brightness(1.1)',
      description: 'Desaturated cool blue-gray. Icy, minimal.',
    },
  ],

  // -- Opacity scale (used throughout for text/border hierarchy) --
  opacityScale: {
    solid: 1.0,
    high: 0.85,
    medium: 0.7,
    low: 0.5,
    subtle: 0.45,
    faint: 0.35,
    ghost: 0.3,
    whisper: 0.25,
    invisible: 0.15,
    border: 0.12,
    borderSubtle: 0.1,
    borderGhost: 0.08,
    borderInvisible: 0.06,
    description: 'Radiant uses a precise 13-step opacity scale for text and borders. This creates visual depth without additional colors. Apply to rgba(232,224,216,X) for text and rgba(200,149,108,X) for accent.',
  },

  // -- Gradient patterns --
  gradients: {
    heroOverlayDesktop: 'linear-gradient(to right, rgba(10, 10, 10, 0.55) 0%, rgba(10, 10, 10, 0.15) 45%, transparent 70%)',
    heroOverlayMobile: 'linear-gradient(to bottom, rgba(10, 10, 10, 0.6) 0%, rgba(10, 10, 10, 0.25) 30%, transparent 55%)',
    backgroundDarkening: 'rgba(10, 10, 10, 0.7)',
    accentMaskFade: 'linear-gradient(to right, transparent 0%, black 40%)',
    ambientGlowPattern: [
      'radial-gradient(ellipse 70% 55% at 20% 0%, rgba(R, G, B, 0.22) 0%, transparent 70%)',
      'radial-gradient(ellipse 55% 50% at 80% 0%, rgba(R, G, B, 0.18) 0%, transparent 70%)',
      'radial-gradient(ellipse 45% 40% at 50% 0%, rgba(R, G, B, 0.14) 0%, transparent 65%)',
    ],
    description: 'Hero uses directional overlay gradients to create text-readable zones over shader backgrounds. Mobile switches to vertical gradient. Ambient glow uses layered radial gradients positioned at top edge for aurora-like effect.',
  },
} as const;

// ============================================
// 2. LAYOUT PATTERNS
// ============================================

export const LAYOUT_PATTERNS = {
  // -- Page-level layouts --
  pageStructures: {
    homepage: {
      structure: 'Hero (100dvh) -> Featured grid -> HowToUse (3-col steps) -> Changelog -> Pricing -> Footer',
      maxWidth: '900px (content sections), 1200px (hero content)',
      description: 'Single-page scroll with full-viewport hero. Sections separated by thin amber borders.',
    },
    galleryLayout: {
      structure: 'Sidebar (240px sticky) + Main (flexible) with floating color controls',
      gridTemplate: '240px 1fr',
      sidebarHeight: 'calc(100vh - var(--nav-height, 56px))',
      sidebarPosition: 'sticky, top: var(--nav-height)',
      description: 'Fixed sidebar with scrollable main area. Sidebar hides on mobile, replaced by hamburger toggle with slide-in drawer.',
    },
    shaderDetailLayout: {
      structure: 'Optional SourceViewer (2fr) + Main preview (3fr) + Sidebar (240px)',
      gridTemplate: '1fr 240px',
      gridTemplateWithSource: 'minmax(320px, 2fr) 3fr 240px',
      fullHeight: '100vh',
      description: 'Three-panel layout when source is open. Fills viewport height. Preview area flexes to fill remaining space.',
    },
  },

  // -- Grid patterns --
  grids: {
    galleryGrid: {
      css: 'grid-template-columns: repeat(auto-fill, minmax(380px, 1fr))',
      gap: '1.5rem',
      padding: '2rem 3rem',
      mobileColumns: '1fr',
      mobileGap: '1rem',
      mobilePadding: '1rem',
      description: 'Auto-fill grid that adapts from 1 to 3+ columns. Min card width 380px ensures readability.',
    },
    featuredGrid: {
      css: 'grid-template-columns: repeat(3, 1fr)',
      gap: '1.25rem',
      tabletColumns: 'repeat(2, 1fr)',
      mobileColumns: '1fr',
      description: 'Fixed 3-column grid for curated selections. Steps down to 2 at 900px, 1 at 640px.',
    },
    stepsGrid: {
      css: 'grid-template-columns: repeat(3, 1fr)',
      gap: '2.5rem',
      mobileColumns: '1fr',
      mobileGap: '2rem',
      description: 'Three equal columns for instructional steps. Single column on mobile.',
    },
  },

  // -- Spacing system --
  spacing: {
    navHeight: '56px',
    navPaddingX: '2rem',
    navMobilePaddingX: '1rem',
    sectionPaddingDesktop: '4rem 3rem to 5rem 3rem',
    sectionPaddingMobile: '1.5rem to 3rem 1.5rem',
    cardPadding: '1.2rem 1.5rem',
    sidebarPaddingY: '1.5rem',
    sidebarItemPaddingX: '1rem',
    controlBarPadding: '0.6rem 1.25rem',
    controlBarMobilePadding: '0.5rem 0.75rem',
    gapSmall: '0.25rem',
    gapMedium: '0.5rem',
    gapDefault: '0.75rem',
    gapLarge: '1.5rem',
    gapXL: '2.5rem',
    gapSection: '3rem',
    cssVariable: '--nav-height: 56px',
    description: 'Spacing uses rem units. Nav height is a CSS variable used throughout for offset calculations. Sections use generous vertical padding (4-5rem desktop, 3rem mobile).',
  },

  // -- Aspect ratios --
  aspectRatios: {
    shaderPreview: '16 / 9',
    cardPreview: '16 / 10',
    heroShaderInline: '4 / 3',
    description: 'Shader previews use 16:9 for cinematic feel. Card thumbnails use slightly taller 16:10. Inline hero shader uses 4:3.',
  },
} as const;

// ============================================
// 3. ANIMATION PATTERNS
// ============================================

export const ANIMATION_PATTERNS = {
  // -- Keyframe animations --
  keyframes: {
    glowBreathe: {
      name: 'glow-breathe',
      duration: '20s',
      timing: 'ease-in-out',
      iteration: 'infinite',
      keyframes: `
        0%, 100% { opacity: 1; transform: scaleX(1); }
        33% { opacity: 0.65; transform: scaleX(1.08); }
        66% { opacity: 0.85; transform: scaleX(0.95); }
      `,
      description: 'Slow ambient breathing effect for background glow elements. Very subtle scale oscillation creates living, organic feel. 20s cycle prevents noticeable repetition.',
    },
    fadeUp: {
      name: 'fadeUp',
      duration: '0.3s',
      timing: 'ease',
      keyframes: `
        from { opacity: 0; transform: translateX(-50%) translateY(10px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      `,
      description: 'Floating controls entrance. Combines centered positioning with upward slide. Quick 300ms for responsive feel.',
    },
  },

  // -- CSS transitions --
  transitions: {
    colorChange: {
      property: 'color',
      duration: '0.2s',
      description: 'Standard hover color transition. Used on all interactive text elements.',
    },
    borderColor: {
      property: 'border-color',
      duration: '0.2s',
      description: 'Border highlight on hover/active states. Subtle and fast.',
    },
    backgroundChange: {
      property: 'background',
      duration: '0.2s',
      description: 'Background fill transition for buttons and controls.',
    },
    cardHover: {
      properties: 'border-color 0.3s ease, transform 0.3s ease',
      transform: 'translateY(-2px)',
      description: 'Card lifts 2px on hover with border brightening. 300ms for smooth feel.',
    },
    opacityReveal: {
      property: 'opacity',
      duration: '0.4s',
      timing: 'ease',
      description: 'Used for iframe/sprite reveal. Shader fades in over 400ms after loading.',
    },
    hintFade: {
      property: 'opacity',
      duration: '0.3s',
      timing: 'ease',
      description: 'Hover hint fades out when shader activates.',
    },
    sliderThumbScale: {
      property: 'transform',
      duration: '0.15s',
      transform: 'scale(1.2) to scale(1.3)',
      description: 'Range slider thumb grows on hover. Quick 150ms snap.',
    },
    schemeDotScale: {
      property: 'transform',
      duration: '0.15s',
      transform: 'scale(1.2)',
      description: 'Color scheme dot enlarges on hover.',
    },
    sidebarSlide: {
      property: 'transform',
      duration: '0.3s',
      timing: 'ease',
      transform: 'translateX(-100%) to translateX(0)',
      description: 'Mobile sidebar slides in from left edge.',
    },
  },

  // -- Motion preferences --
  motionPreferences: {
    reducedMotion: 'prefers-reduced-motion: reduce',
    smoothScroll: '@media (prefers-reduced-motion: no-preference) { html:not(.restoring-scroll) { scroll-behavior: smooth; } }',
    shaderPause: 'var prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;',
    description: 'All shaders check prefers-reduced-motion on init. Smooth scroll respects user preference. Navigation back/forward temporarily disables smooth scroll for instant restoration.',
  },

  // -- Shader animation techniques --
  shaderTechniques: {
    visibilityPause: {
      method: 'IntersectionObserver with rootMargin: 200px',
      description: 'Shaders pause requestAnimationFrame when off-screen. 200px rootMargin prefetches before scrolling into view.',
    },
    iframePauseResume: {
      pause: 'window.__shaderPause() - queues rAF callbacks',
      resume: 'window.__shaderResume() - flushes queued callbacks',
      description: 'Custom pause/resume injected into shader HTML via script tag in <head>. Patches window.requestAnimationFrame to queue/flush callbacks.',
    },
    dprAwareness: {
      implementation: 'Canvas DPR capped at 2x',
      description: 'All shaders account for device pixel ratio but cap at 2x to prevent GPU overload on 3x+ screens.',
    },
    postMessageParams: {
      format: '{ type: "param", name: "PARAM_NAME", value: number }',
      description: 'Runtime parameter control via iframe.contentWindow.postMessage(). Each shader declares its tunable parameters.',
    },
    mouseInteraction: {
      implementation: 'mousemove/mousedown/click/touchstart/touchmove listeners',
      description: 'Most shaders respond to mouse position and/or click/drag. Interaction hints auto-detected from script content.',
    },
    lerpSmoothing: {
      rate: 0.06,
      implementation: 'currentValue += (targetValue - currentValue) * 0.06',
      description: 'Hero drag-to-rotate uses linear interpolation at 6% per frame for buttery smooth camera movement.',
    },
  },
} as const;

// ============================================
// 4. COMPONENT PATTERNS
// ============================================

export const COMPONENT_PATTERNS = {
  // -- Hero section --
  hero: {
    layout: 'Full viewport (100dvh) with shader iframe background',
    contentPlacement: 'Left-aligned, vertically centered, max-width 600px',
    overlay: 'Directional gradient from left (dark) to right (transparent)',
    controls: 'Floating pill bar at bottom center with backdrop-filter blur',
    interactivity: 'Drag to rotate camera, range sliders for params, color scheme dots',
    css: {
      height: '100dvh',
      cursor: 'grab (dragging: grabbing)',
      iframeTransition: 'opacity 0.4s ease (starts at 0, reveals on .ready class)',
      contentPadding: '0 3rem',
      headingSize: 'clamp(3rem, 8vw, 6rem)',
      headingWeight: 300,
      headingColor: '#c8956c',
      taglineSize: 'clamp(0.95rem, 2vw, 1.15rem)',
    },
    description: 'Full-bleed shader hero with content overlaid via gradient mask. Controls bar uses glass-morphism (backdrop-filter: blur(12px), semi-transparent background, subtle amber border). Mobile collapses to centered text with bottom padding for controls.',
  },

  // -- Navigation --
  nav: {
    position: 'fixed, top: 0, z-index: 100',
    height: 'var(--nav-height, 56px)',
    background: 'rgba(10, 10, 10, 0.85)',
    backdropFilter: 'blur(12px)',
    borderBottom: '1px solid rgba(200, 149, 108, 0.1)',
    logoStyle: 'font-weight: 300, color: #c8956c, letter-spacing: 0.05em',
    linkStyle: 'font-size: 0.8rem, color: rgba(232, 224, 216, 0.5), hover: #c8956c',
    description: 'Translucent glass nav. Blur creates depth separation from content. Very thin border for definition. Logo is light-weight amber text. Links are muted warm-white, amber on hover.',
  },

  // -- Shader Card --
  card: {
    border: '1px solid rgba(var(--card-accent), 0.25)',
    borderRadius: '8px',
    background: '#111',
    hoverBorderColor: 'rgba(var(--card-accent), 0.55)',
    hoverTransform: 'translateY(-2px)',
    previewAspectRatio: '16 / 10',
    previewBackground: '#0a0a0a',
    spriteBackgroundSize: '100% 600%',
    cssVariable: '--card-accent (RGB triplet, e.g. "200, 149, 108")',
    infoSection: {
      padding: '1.2rem 1.5rem',
      numberStyle: 'font-size: 0.7rem, uppercase, letter-spacing: 0.15em, color: #c8956c',
      titleStyle: 'font-size: 1.1rem, font-weight: 500',
      descStyle: 'font-size: 0.8rem, color: rgba(232,224,216,0.5), line-height: 1.5',
      actionStyle: 'font-size: 0.75rem, uppercase, letter-spacing: 0.1em, color: #c8956c',
    },
    hoverHint: {
      position: 'absolute bottom center',
      style: 'font-size: 0.6rem, uppercase, letter-spacing: 0.12em, backdrop-filter: blur(4px)',
      background: 'rgba(10, 10, 10, 0.6)',
      border: '1px solid rgba(200, 149, 108, 0.12)',
    },
    description: 'Cards use CSS custom property for per-card accent color (driven by inspiration artist palette). Preview area shows sprite sheet (6 color scheme frames stacked vertically). On hover, iframe loads and fades in over sprite. Card lifts 2px with border brightening. Number label uses monospace uppercase convention.',
  },

  // -- Buttons --
  buttons: {
    solid: {
      padding: '0.65rem 1.5rem to 0.75rem 2rem',
      background: '#c8956c',
      color: '#0a0a0a',
      borderRadius: '6px',
      fontWeight: 500,
      fontSize: '0.85rem to 0.9rem',
      letterSpacing: '0.02em',
      hoverBackground: '#d4a57c',
      transition: 'background 0.2s',
    },
    ghost: {
      padding: '0.65rem 1.5rem to 0.7rem 1.5rem',
      background: 'transparent',
      border: '1px solid rgba(200, 149, 108, 0.25 to 0.4)',
      color: '#c8956c or rgba(232,224,216,0.6)',
      borderRadius: '6px',
      hoverBorderColor: 'rgba(200, 149, 108, 0.5 to 0.7)',
      transition: 'background 0.2s, border-color 0.2s',
    },
    controlButton: {
      padding: '0.3rem 0.55rem',
      background: 'transparent',
      border: '1px solid rgba(200, 149, 108, 0.1)',
      borderRadius: '4px',
      fontSize: '0.65rem',
      activeState: 'border-color: rgba(200,149,108,0.5), color: #c8956c, background: rgba(200,149,108,0.06)',
    },
    actionButton: {
      padding: '0.4rem 0.75rem',
      fontSize: '0.65rem',
      fontWeight: 500,
      color: '#c8956c',
      border: '1px solid rgba(200, 149, 108, 0.2)',
      borderRadius: '4px',
      hoverBackground: 'rgba(200, 149, 108, 0.06)',
    },
    description: 'Two primary button types: solid (amber fill, dark text) and ghost (transparent, amber border). Control buttons are smaller, used in sidebars. Action buttons are compact for toolbar contexts. All use fast 200ms transitions.',
  },

  // -- Sidebar --
  sidebar: {
    width: '240px',
    background: '#0f0f0f',
    borderRight: '1px solid rgba(200, 149, 108, 0.1)',
    position: 'sticky',
    sectionHeading: 'font-size: 0.6rem, uppercase, letter-spacing: 0.15em, color: #c8956c, font-weight: 500',
    linkStyle: 'font-size: 0.8rem, color: rgba(232,224,216,0.5), padding: 0.4rem 1rem',
    activeLinkStyle: 'color: #c8956c, background: rgba(200,149,108,0.08), border-left: 2px solid #c8956c',
    countBadge: 'font-size: 0.65rem, color: rgba(232,224,216,0.25)',
    scrollbar: 'width: 4px, thumb: rgba(200,149,108,0.15)',
    mobileHidden: 'display: none at 768px, slide-in drawer on toggle',
    description: 'Sticky sidebar with category navigation. Active state uses left accent border. Section headings are tiny uppercase amber labels. Counts are very muted. Custom thin scrollbar matches theme.',
  },

  // -- Floating controls bar --
  floatingControls: {
    position: 'fixed, bottom: 1.5rem, left: 50%, transform: translateX(-50%)',
    zIndex: 50,
    background: 'rgba(10, 10, 10, 0.5 to 0.6)',
    backdropFilter: 'blur(12px)',
    border: '1px solid rgba(200, 149, 108, 0.12)',
    borderRadius: '40px (desktop), 30px (mobile)',
    padding: '0.5rem 1rem (desktop), 0.4rem 0.75rem (mobile)',
    entrance: 'fadeUp animation 0.3s ease',
    description: 'Pill-shaped glass-morphism controls floating at bottom center. Used for both hero controls and gallery color scheme picker. Appears with upward fade animation when gallery scrolls into view.',
  },

  // -- Source viewer panel --
  sourceViewer: {
    background: '#0d0d0d',
    borderRight: '1px solid rgba(200, 149, 108, 0.12)',
    headerBorder: '1px solid rgba(200, 149, 108, 0.1)',
    titleStyle: 'font-size: 0.7rem, uppercase, letter-spacing: 0.12em, color: rgba(232,224,216,0.4)',
    codeFont: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    codeFontSize: '0.7rem',
    codeLineHeight: 1.7,
    codeColor: 'rgba(232, 224, 216, 0.65)',
    tabSize: 2,
    scrollbar: 'width: 6px, thumb: rgba(200,149,108,0.2), hover: rgba(200,149,108,0.35)',
    description: 'Side panel for viewing shader source code. Monospace font with generous line height for readability. Custom scrollbar matches theme. Panel title uses uppercase convention.',
  },

  // -- Changelog --
  changelog: {
    entryBorderLeft: '1px solid rgba(200, 149, 108, 0.15)',
    entryPaddingLeft: '1.5rem',
    versionStyle: 'font-size: 0.9rem, font-weight: 500, color: rgba(232,224,216,0.8)',
    dateStyle: 'font-size: 0.75rem, color: rgba(232,224,216,0.3)',
    listItemBullet: 'width: 4px, height: 4px, border-radius: 50%, background: rgba(200,149,108,0.3)',
    listItemStyle: 'font-size: 0.82rem, line-height: 1.7, color: rgba(232,224,216,0.45)',
    description: 'Timeline-style changelog with left border accent. Tiny amber dot bullets. Very muted text keeps focus on structure.',
  },

  // -- How to Use (steps) --
  howToUse: {
    stepNumberStyle: 'font-size: 2.5rem, font-weight: 200, color: rgba(200,149,108,0.45)',
    stepTitleStyle: 'font-size: 1rem, font-weight: 500, color: rgba(232,224,216,0.85)',
    stepDescStyle: 'font-size: 0.85rem, line-height: 1.6, color: rgba(232,224,216,0.45)',
    description: 'Large light-weight numbers as visual anchors. Three-column grid with generous gap. Step numbers are oversized and muted amber - decorative rather than informational.',
  },

  // -- Ambient glow --
  ambientGlow: {
    implementation: 'Layered radial gradients positioned at top edge',
    gradientPattern: 'Elliptical radial-gradient at different X positions (20%, 80%, 50%)',
    opacities: [0.22, 0.18, 0.14],
    animation: 'glow-breathe 20s ease-in-out infinite',
    positioning: 'position: absolute, inset: 0, pointer-events: none',
    description: 'Creates aurora-like colored glow across top of inspiration gallery pages. Uses artist palette colors. Subtle breathing animation (opacity + scaleX) prevents static appearance.',
  },

  // -- Footer --
  footer: {
    borderTop: '1px solid rgba(200, 149, 108, 0.1)',
    padding: '2rem 3rem',
    wordmarkStyle: 'font-size: 1rem, font-weight: 500, letter-spacing: 0.05em, color: #c8956c',
    linkStyle: 'font-size: 0.8rem, color: rgba(232,224,216,0.5), hover: #e8e0d8',
    socialStyle: 'color: rgba(232,224,216,0.4), hover: #c8956c',
    copyrightStyle: 'font-size: 0.7rem, color: rgba(232,224,216,0.3)',
    bottomBorder: '1px solid rgba(200,149,108,0.06)',
    description: 'Two-tier footer. Top tier: wordmark, links, social icons. Bottom tier: copyright and license. Very muted to not compete with content.',
  },

  // -- Range sliders --
  rangeSliders: {
    trackHeight: '3px to 4px',
    trackBackground: 'rgba(200, 149, 108, 0.12 to 0.15)',
    trackBorderRadius: '2px',
    thumbSize: '10px to 12px',
    thumbBackground: '#c8956c',
    thumbBorderRadius: '50%',
    thumbHoverScale: 'scale(1.2 to 1.3)',
    thumbTransition: 'transform 0.15s',
    labelStyle: 'font-size: 0.65rem, uppercase, letter-spacing: 0.1em, color: rgba(200,149,108,0.5)',
    valueStyle: 'font-size: 0.6rem, color: rgba(232,224,216,0.3), font-variant-numeric: tabular-nums',
    description: 'Custom styled range inputs. Thin amber tracks with round amber thumbs that grow on hover. Labels are tiny uppercase. Values use tabular-nums for alignment.',
  },

  // -- Interaction hint --
  interactionHint: {
    font: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: '10px',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'rgba(200, 149, 108, 0.8)',
    background: 'rgba(10, 10, 10, 0.75)',
    backdropFilter: 'blur(8px)',
    border: '1px solid rgba(200, 149, 108, 0.12)',
    padding: '4px 10px',
    borderRadius: '4px',
    position: 'absolute, bottom: 12px, right: 14px',
    transition: 'opacity 0.3s ease',
    description: 'Monospace hint label floating over shader preview. Auto-detected based on shader interaction capabilities (click, drag, move). Glass-morphism style matching controls.',
  },
} as const;

// ============================================
// 5. TYPOGRAPHY PATTERNS
// ============================================

export const TYPOGRAPHY_PATTERNS = {
  // -- Font stack --
  fontStack: {
    primary: "'Inter', -apple-system, system-ui, sans-serif",
    mono: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    weights: {
      200: 'Step numbers (decorative)',
      300: 'Hero heading, section headings, logo',
      400: 'Body text (default)',
      500: 'Button text, card titles, bold labels',
      600: 'Mock logo in templates, nav logo weight',
    },
    googleFontsImport: "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap",
    description: 'Inter is the only custom font. Light weights (300) dominate headings for an airy, premium feel. Body uses 400. Bold elements use 500. Monospace used for code, labels, and shader titles.',
  },

  // -- Type scale --
  typeScale: {
    heroHeading: 'clamp(3rem, 8vw, 6rem)',
    heroHeadingMobile: '2.5rem',
    sectionHeading: '1.5rem',
    mockHeading: '1.3rem',
    cardTitle: '1.1rem',
    bodyLarge: '1.1rem',
    body: '0.9rem',
    bodySmall: '0.85rem',
    caption: '0.8rem',
    label: '0.7rem',
    microLabel: '0.65rem',
    tinyLabel: '0.6rem',
    miniLabel: '0.55rem',
    description: 'Hero uses fluid type via clamp(). Rest of the scale is static rem values. Hierarchy goes from 1.5rem section headings down to 0.55rem for hint text. Very few sizes above 1.5rem, keeping the overall feel restrained.',
  },

  // -- Letter-spacing system --
  letterSpacing: {
    wide: '0.15em',      // Uppercase micro labels, shader numbers
    medium: '0.12em',    // Panel titles, live toggle, uppercase labels
    normal: '0.1em',     // Range labels, action text, hints
    slight: '0.08em',    // Scheme button labels
    minimal: '0.05em',   // Logo, section headings
    tight: '0.03em',     // Hero heading, button text, mock logo
    default: '0.02em',   // Buttons
    description: 'Letter-spacing is consistently applied to uppercase elements (wider) and brand elements (minimal). This creates the refined, editorial typography feel.',
  },

  // -- Line heights --
  lineHeights: {
    tight: 1.0,          // Step numbers
    heading: 1.1,        // Hero heading
    compact: 1.2,        // Content headings
    default: 1.4,        // Credit text
    relaxed: 1.5,        // Card descriptions
    body: 1.6,           // Paragraphs, taglines, steps
    code: 1.7,           // Source code, changelog items, intros
    description: 'Code and changelog use generous 1.7 line-height for scan-ability. Body paragraphs use 1.6. Headings compress to 1.1-1.2.',
  },
} as const;

// ============================================
// 6. VISUAL EFFECTS
// ============================================

export const VISUAL_EFFECTS = {
  // -- Backdrop blur (glass morphism) --
  backdropBlur: {
    strong: 'backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px)',
    medium: 'backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px)',
    light: 'backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px)',
    usage: 'Nav bar, floating controls, hover hints, sidebar toggle',
    description: 'Glass morphism is the primary depth technique. Always include -webkit prefix. Combined with semi-transparent dark backgrounds (rgba(10,10,10,0.5-0.85)) and thin amber borders.',
  },

  // -- Border system --
  borders: {
    standard: '1px solid rgba(200, 149, 108, 0.1)',
    subtle: '1px solid rgba(200, 149, 108, 0.08)',
    ghost: '1px solid rgba(200, 149, 108, 0.06)',
    cardDefault: '1px solid rgba(var(--card-accent), 0.25)',
    cardHover: '1px solid rgba(var(--card-accent), 0.55)',
    activeIndicator: '2px solid #c8956c (left border on active sidebar items)',
    controlBorder: '1px solid rgba(200, 149, 108, 0.12)',
    description: 'All borders use amber at very low opacity. This creates definition without harshness. Card borders use CSS custom property for per-card accent. Active states increase opacity.',
  },

  // -- CSS mask/clip --
  masks: {
    accentFade: '-webkit-mask-image: linear-gradient(to right, transparent 0%, black 40%); mask-image: linear-gradient(to right, transparent 0%, black 40%)',
    description: 'Used in accent layout to fade shader from transparent to opaque, creating a dramatic side reveal effect. Always include -webkit prefix.',
  },

  // -- Scrollbar customization --
  scrollbars: {
    webkit: {
      width: '4px to 6px',
      trackBackground: 'transparent',
      thumbBackground: 'rgba(200, 149, 108, 0.15 to 0.2)',
      thumbHover: 'rgba(200, 149, 108, 0.3 to 0.35)',
      thumbBorderRadius: '2px to 3px',
    },
    firefox: {
      scrollbarWidth: 'thin',
      scrollbarColor: 'rgba(200, 149, 108, 0.2) transparent',
    },
    description: 'Custom scrollbars matching amber theme. Very thin (4-6px). Both Webkit and Firefox syntaxes. Track is transparent, thumb is muted amber.',
  },

  // -- Overlay patterns --
  overlays: {
    darkening: 'rgba(10, 10, 10, 0.7)',
    directionalFade: 'linear-gradient(to right, rgba(10,10,10,0.55) 0%, rgba(10,10,10,0.15) 45%, transparent 70%)',
    mobileOverlay: 'linear-gradient(to bottom, rgba(10,10,10,0.6) 0%, rgba(10,10,10,0.25) 30%, transparent 55%)',
    sidebarOverlay: 'rgba(0, 0, 0, 0.5)',
    description: 'Overlays ensure text readability over shaders. Desktop uses left-to-right gradient (content side darker). Mobile switches to top-down. Sidebar mobile overlay is simple semi-black.',
  },

  // -- Color scheme filters (applied to iframes) --
  colorFilters: {
    grayscale: 'grayscale(1)',
    hueRotateBlue: 'hue-rotate(175deg)',
    hueRotateRose: 'hue-rotate(300deg) saturate(1.1)',
    hueRotateEmerald: 'hue-rotate(90deg) saturate(1.2)',
    arctic: 'hue-rotate(180deg) saturate(0.5) brightness(1.1)',
    description: 'Color schemes are pure CSS filter chains applied to shader iframes. No shader modification needed. This technique works with any visual content and allows runtime switching.',
  },

  // -- Shader-specific visual techniques --
  shaderVisualTechniques: {
    simplexNoise: 'Domain-warped simplex noise for organic flow (Fluid Amber, Shifting Veils)',
    perlinNoise: 'Perlin noise currents for particle flow fields (Flow Field)',
    fbmNoise: 'Fractal Brownian Motion with domain rotation to reduce grid artifacts',
    voronoiPatterns: 'Voronoi fracture patterns (Sugar Glass, Gilded Fracture)',
    reactionDiffusion: 'Gray-Scott reaction-diffusion for organic maze patterns (Edge of Chaos)',
    metaballs: 'Raymarched metaball merging with liquid-metal surface (Metamorphosis)',
    thinFilmInterference: 'Holographic thin-film color shifts (Artpop Iridescence)',
    gravitationalLensing: 'Schwarzschild raytracing with Doppler beaming (Event Horizon)',
    chladniPatterns: 'Standing wave interference patterns on vibrating plates',
    particleSystems: 'Spring-connected grids, flocking boids, magnetic field alignment',
    volumetricLighting: 'Spotlight cones with dust scattering (Velvet Spotlight)',
    chromaticAberration: 'Color channel separation for holographic/glitch effects',
    lissajousFigures: 'Parametric curves with phosphor persistence (Analog Drift)',
    description: 'Shader techniques span Canvas 2D (particle systems, parametric drawing) and WebGL (GLSL fragment shaders). Most use time-based animation with mouse interaction. All target 60fps.',
  },

  // -- Shader base styles --
  shaderBaseCSS: `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #0a0a0a; }
    canvas { display: block; width: 100vw; height: 100vh; }
    .label {
      position: fixed;
      top: 20px;
      left: 24px;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 11px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: rgba(200, 149, 108, 0.5);
      z-index: 10;
      pointer-events: none;
      user-select: none;
    }
  `,
} as const;

// ============================================
// 7. RESPONSIVE PATTERNS
// ============================================

export const RESPONSIVE_PATTERNS = {
  breakpoints: {
    mobile: '640px',
    tablet: '768px',
    desktop: '900px',
    wide: '1200px',
    description: 'Three primary breakpoints: 640px (mobile), 768px (tablet/sidebar collapse), 900px (grid column reduction). Content max-widths: 600px (hero content), 800px (support), 900px (how-to-use, changelog).',
  },

  mobileAdaptations: {
    '640px': {
      heroContent: 'Centered text, bottom padding 30vh for controls, max-width none',
      heroHeading: '2.5rem (from clamp)',
      heroOverlay: 'Vertical gradient instead of horizontal',
      heroControls: 'Flex-wrap, smaller gaps, labels hidden, range inputs narrower',
      sectionPadding: '1.5rem to 3rem 1.5rem (from 3-5rem 3rem)',
      gridColumns: '1fr (from auto-fill/3-col)',
      gridGap: '1rem (from 1.25-1.5rem)',
      stepsGrid: '1fr (from repeat(3, 1fr))',
      navPadding: '0 1rem (from 0 2rem)',
      navLinkGap: '1rem (from 1.5rem)',
      floatingControls: 'Smaller padding, labels hidden, radius reduced to 30px',
      footer: 'Stack vertically instead of horizontal',
    },
    '768px': {
      sidebar: 'Hidden by default, slide-in drawer via hamburger',
      galleryGrid: '1fr (from 240px + 1fr)',
      shaderDetail: 'Single column, source viewer hidden, sidebar below preview',
      colorSchemeDots: 'Larger (16px), text hidden, circular buttons',
    },
    '900px': {
      featuredGrid: 'repeat(2, 1fr) (from repeat(3, 1fr))',
    },
  },

  adaptivePatterns: {
    fluidType: 'clamp(3rem, 8vw, 6rem) for hero heading',
    iframeFilterInheritance: 'style:filter={scheme.filter} on iframes for runtime color change',
    spriteSheets: '6-frame vertical sprite for shader previews (one per color scheme)',
    scrollBehavior: 'Disabled during popstate navigation for instant scroll restoration',
    stickyPositioning: 'sidebar sticky to top of viewport below nav',
    cssVariables: '--nav-height: 56px, --card-accent: "R, G, B"',
    description: 'Key adaptive patterns: fluid type for hero, CSS variables for computed offsets, sprite sheets for instant color scheme previews without re-rendering, scroll restoration handling.',
  },
} as const;

// ============================================
// 8. SHADER CATALOG
// ============================================

export type ShaderTag = 'fill' | 'object' | 'particles' | 'physics' | 'noise' | 'organic' | 'geometric';
export type ShaderTechnique = 'canvas-2d' | 'webgl';

export interface ShaderEntry {
  id: string;
  title: string;
  description: string;
  tags: ShaderTag[];
  technique: ShaderTechnique;
  inspiration?: string;
  hasHeroConfig?: boolean;
  defaultScheme?: string;
  parameterNames: string[];
}

export const SHADER_CATALOG: ShaderEntry[] = [
  { id: 'flow-field', title: 'Flow Field with Particle Trails', description: 'Particles following Perlin noise currents with warm amber trails.', tags: ['fill', 'particles', 'noise'], technique: 'canvas-2d', parameterNames: ['SPEED', 'NOISE_SCALE'] },
  { id: 'topographic', title: 'Topographic Contour Map', description: 'Living terrain map with marching squares isolines and elevation labels.', tags: ['fill', 'noise', 'geometric'], technique: 'canvas-2d', parameterNames: ['NUM_CONTOURS', 'TIME_SPEED'] },
  { id: 'generative-tree', title: 'Generative Branching Tree', description: 'L-system inspired tree with continuous growth and regrowth cycles.', tags: ['object', 'organic'], technique: 'canvas-2d', parameterNames: ['GROWTH_SPEED_BASE', 'MAX_DEPTH'] },
  { id: 'strange-attractor', title: 'Strange Attractor (Lorenz)', description: 'Lorenz system with 3D projection, rotation, and glowing particle trails.', tags: ['object', 'particles', 'physics'], technique: 'canvas-2d', parameterNames: ['STEPS_PER_FRAME', 'TRAIL_LENGTH', 'RHO'] },
  { id: 'pendulum-wave', title: 'Pendulum Wave', description: 'Physics-based pendulum wave creating emergent interference patterns.', tags: ['object', 'physics'], technique: 'canvas-2d', parameterNames: ['NUM_PENDULUMS', 'CYCLE_DURATION'] },
  { id: 'phyllotaxis', title: 'Phyllotaxis Spiral', description: 'Golden angle spiral with Fibonacci lattice connections.', tags: ['object', 'geometric', 'organic'], technique: 'canvas-2d', parameterNames: ['MAX_POINTS', 'SPREAD'] },
  { id: 'fluid-amber', title: 'Fluid Amber', description: 'Domain-warped simplex noise with layered organic flow and warm palette.', tags: ['fill', 'noise', 'organic'], technique: 'webgl', parameterNames: ['timeScale', 'ampDecay'] },
  { id: 'champagne-fizz', title: 'Champagne Fizz', description: 'Effervescent bubbles rising with wobble physics, refractive highlights, and sparkle bursts.', tags: ['fill', 'particles', 'physics'], technique: 'canvas-2d', inspiration: 'Sabrina Carpenter', parameterNames: ['BUBBLE_RATE', 'RISE_SPEED'] },
  { id: 'sugar-glass', title: 'Sugar Glass', description: 'Caramelized sugar glass with Voronoi fracture patterns and golden light bleeding through cracks.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: 'Sabrina Carpenter', parameterNames: ['CRACK_SPEED', 'LIGHT_BLEED'] },
  { id: 'resonant-strings', title: 'Resonant Strings', description: 'Vibrating cello strings with standing wave harmonics, overtone interference, and rosin dust particles.', tags: ['object', 'physics'], technique: 'canvas-2d', inspiration: 'Laufey', parameterNames: ['HARMONIC_COUNT', 'VIBRATION_SPEED'] },
  { id: 'chladni-resonance', title: 'Chladni Resonance', description: 'Sand patterns forming on a vibrating plate, morphing between harmonic modes with golden glow.', tags: ['object', 'geometric', 'physics'], technique: 'webgl', inspiration: 'Laufey', parameterNames: ['MODE_SPEED', 'COMPLEXITY'] },
  { id: 'kinetic-grid', title: 'Kinetic Grid', description: 'Spring-connected grid mesh with traveling force impulses, tension-colored connections in cyan and magenta.', tags: ['fill', 'physics'], technique: 'canvas-2d', inspiration: 'Dua Lipa', parameterNames: ['IMPULSE_RATE', 'SPRING_TENSION', 'IMPULSE_STRENGTH', 'DAMPING', 'RETURN_FORCE'] },
  { id: 'strobe-geometry', title: 'Strobe Geometry', description: 'Sharp neon geometric shapes flashing in choreographed sequence with cyan-to-magenta afterglow decay.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: 'Dua Lipa', parameterNames: ['FLASH_RATE', 'GLOW_INTENSITY'] },
  { id: 'laser-labyrinth', title: 'Laser Labyrinth', description: 'Volumetric laser beams crossing in a dark void with prismatic colors and intersection flares.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: 'Dua Lipa', parameterNames: ['SWEEP_SPEED', 'BEAM_INTENSITY'] },
  { id: 'bass-ripple', title: 'Bass Ripple', description: 'Vibrating speaker mesh with beat-synced wave displacement and metallic specular sheen.', tags: ['fill', 'physics'], technique: 'webgl', inspiration: 'Dua Lipa', parameterNames: ['BASS_FREQ', 'BASS_INTENSITY'] },
  { id: 'ink-dissolve', title: 'Ink Dissolve', description: 'Dense ink tendrils spreading through amber liquid with reaction-diffusion branching patterns.', tags: ['fill', 'noise', 'organic'], technique: 'webgl', inspiration: 'Billie Eilish', parameterNames: ['SPREAD_SPEED', 'TENDRIL_DETAIL'] },
  { id: 'sequin-wave', title: 'Sequin Wave', description: 'Grid of metallic sequin discs catching sweeping light with specular reflections and warm shimmer.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: 'Taylor Swift', parameterNames: ['WAVE_SPEED', 'SPARKLE_INTENSITY'] },
  { id: 'gilt-mosaic', title: 'Gilt Mosaic', description: 'Byzantine golden mosaic wall with individually shimmering tiles catching candlelight.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: 'Beyonce', parameterNames: ['ANIM_MODE', 'TILE_SCALE', 'WAVE_SPEED', 'WAVE_DELAY', 'WAVE_DIR'] },
  { id: 'gilded-fracture', title: 'Gilded Fracture', description: 'Kintsugi-inspired golden cracks spreading across dark surface with molten gold light bleeding through.', tags: ['fill', 'noise', 'organic'], technique: 'webgl', inspiration: 'Beyonce', parameterNames: ['CRACK_SPEED', 'GLOW_INTENSITY'] },
  { id: 'radiant-geometry', title: 'Radiant Geometry', description: 'Animated Islamic geometric art with layered golden star patterns and counter-rotating tracery.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: 'Beyonce', parameterNames: ['ROTATION_SPEED', 'PATTERN_COMPLEXITY'] },
  { id: 'golden-throne', title: 'Golden Throne', description: 'Sacred geometry mandala with golden ratio spirals and counter-rotating layers.', tags: ['object', 'geometric'], technique: 'webgl', inspiration: 'Beyonce', parameterNames: ['ROTATION_SPEED', 'COMPLEXITY'] },
  { id: 'sacred-strange', title: 'Sacred Strange', description: 'Fractal golden geometry with overlapping star motifs creating Doctor Strange-like dimensional patterns.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: 'Benedict Cumberbatch', parameterNames: ['ROTATION_SPEED', 'PATTERN_COMPLEXITY', 'PATTERN'] },
  { id: 'tropical-heat', title: 'Tropical Heat', description: 'Heat shimmer distortion with chromatic aberration and tropical color blooms.', tags: ['fill', 'noise'], technique: 'webgl', inspiration: 'Bad Bunny', parameterNames: ['HEAT_INTENSITY', 'COLOR_VIBRANCY'] },
  { id: 'neon-drip', title: 'Neon Drip', description: 'Metaball blobs dripping upward with surface tension physics and trailing tendrils.', tags: ['fill', 'organic'], technique: 'webgl', inspiration: 'Bad Bunny', parameterNames: ['DRIP_SPEED', 'BLOB_COUNT'] },
  { id: 'voltage-arc', title: 'Voltage Arc', description: 'Electric plasma arcs crackling between floating conductor points with warm glow.', tags: ['object', 'physics'], technique: 'webgl', inspiration: 'Bad Bunny', parameterNames: ['ARC_INTENSITY', 'CRACKLE_SPEED'] },
  { id: 'moonlit-ripple', title: 'Moonlit Ripple', description: 'Moon reflection on dark water with multi-directional waves, Fresnel reflection, and 3D perspective.', tags: ['fill', 'noise'], technique: 'webgl', inspiration: 'SZA', defaultScheme: 'blue', parameterNames: ['RIPPLE_SPEED', 'MOON_GLOW', 'CAMERA_TILT', 'WAVE_INTENSITY'] },
  { id: 'eclipse-glow', title: 'Eclipse Glow', description: 'Solar eclipse corona with radial noise rays, diamond ring effect, and streaming solar wind.', tags: ['object', 'noise'], technique: 'webgl', inspiration: 'SZA', parameterNames: ['CORONA_SIZE', 'RAY_INTENSITY'] },
  { id: 'diamond-caustics', title: 'Diamond Caustics', description: 'Light refracting through rotating diamond facets casting prismatic caustic patterns.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: 'Rihanna', parameterNames: ['ROTATION_SPEED', 'BRILLIANCE'] },
  { id: 'rain-on-glass', title: 'Rain on Glass', description: 'Ultra-realistic water droplets on a window, refracting a blurred city night with realistic trail physics.', tags: ['fill', 'physics', 'noise'], technique: 'webgl', inspiration: 'Rihanna', parameterNames: ['RAIN_AMOUNT', 'REFRACTION'] },
  { id: 'rain-umbrella', title: 'Rain on Umbrella', description: 'Looking up through a translucent umbrella at city lights, with refractive drops sliding down the dome.', tags: ['fill', 'physics', 'noise'], technique: 'webgl', inspiration: 'Rihanna', parameterNames: ['RAIN_AMOUNT', 'REFRACTION', 'WALK_SPEED'] },
  { id: 'metamorphosis', title: 'Metamorphosis', description: 'Raymarched metaballs continuously merging and splitting with liquid-metal surface.', tags: ['object', 'organic'], technique: 'webgl', inspiration: 'Lady Gaga', parameterNames: ['MORPH_SPEED', 'BLOB_COUNT'] },
  { id: 'artpop-iridescence', title: 'Artpop Iridescence', description: 'Holographic membrane with thin-film interference creating prismatic color shifts across an undulating surface.', tags: ['fill', 'organic', 'noise'], technique: 'webgl', inspiration: 'Lady Gaga', hasHeroConfig: true, parameterNames: ['FILM_THICKNESS', 'FLOW_SPEED'] },
  { id: 'silk-groove', title: 'Silk Groove', description: 'Flowing silk ribbons with specular highlights and cloth-like wave animation.', tags: ['fill', 'organic'], technique: 'webgl', inspiration: 'Bruno Mars', parameterNames: ['FLOW_SPEED', 'WAVE_AMPLITUDE'] },
  { id: 'gilt-thread', title: 'Gilt Thread', description: 'Golden threads tracing intricate parametric curves with metallic sheen and sparkle tips.', tags: ['object', 'geometric'], technique: 'webgl', inspiration: 'Bruno Mars', parameterNames: ['SHAPE', 'DRAW_SPEED', 'THREAD_COUNT'] },
  { id: 'event-horizon', title: 'Event Horizon', description: 'Physics-based black hole with raytraced gravitational lensing, volumetric accretion disk, and Doppler beaming.', tags: ['object', 'physics'], technique: 'webgl', inspiration: 'The Weeknd', hasHeroConfig: true, parameterNames: ['ROTATION_SPEED', 'DISK_INTENSITY', 'TILT', 'ROTATE', 'CHROMATIC'] },
  { id: 'burning-film', title: 'Burning Film', description: 'Celluloid film stock catching fire with spreading amber burn holes, glowing edges, and ember field.', tags: ['fill', 'noise'], technique: 'webgl', inspiration: 'The Weeknd', parameterNames: ['BURN_SPEED', 'EMBER_GLOW'] },
  { id: 'vertigo', title: 'Vertigo', description: 'Slow hypnotic tunnel with crimson ring segments, wave-based illumination, and dark void center.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: 'The Weeknd', parameterNames: ['TUNNEL_SPEED', 'SPIRAL_INTENSITY'] },
  { id: 'stardust-veil', title: 'Stardust Veil', description: 'Dense cosmic stardust with parallax depth layers, aurora ribbons, constellation threads, and brightness waves.', tags: ['fill', 'particles', 'noise'], technique: 'webgl', inspiration: 'Ariana Grande', parameterNames: ['DRIFT_SPEED', 'STAR_DENSITY'] },
  { id: 'silk-cascade', title: 'Silk Cascade', description: 'Flowing layered silk fabric with anisotropic specular highlights, parallax depth, and warm translucent overlap.', tags: ['fill', 'organic', 'noise'], technique: 'webgl', inspiration: 'Ariana Grande', parameterNames: ['FLOW_SPEED', 'SHEEN_INTENSITY'] },
  { id: 'smolder', title: 'Smolder', description: 'Radial warmth radiating through animated turbulence with heat shimmer, ember particles, and cool blue edges.', tags: ['fill', 'noise'], technique: 'webgl', inspiration: 'Pedro Pascal', hasHeroConfig: true, parameterNames: ['HEAT_INTENSITY', 'TURBULENCE'] },
  { id: 'signal-decay', title: 'Signal Decay', description: 'Clean amber waveforms progressively degrading into gorgeous warm noise - order dissolving into beautiful chaos.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: 'Billie Eilish', parameterNames: ['SIGNAL_SPEED', 'DECAY_INTENSITY'] },
  { id: 'neon-revival', title: 'Neon Revival', description: 'Flickering neon sign with electrical buzz, dripping light particles, and wall reflections.', tags: ['object', 'particles'], technique: 'webgl', inspiration: 'Chappell Roan', hasHeroConfig: true, parameterNames: ['SHAPE', 'FLICKER_RATE', 'GLOW_SPREAD'] },
  { id: 'lipstick-smear', title: 'Lipstick Smear', description: 'Viscous fluid simulation in hot pink and crimson - bold pigment streaking and blending with metallic sheen.', tags: ['fill', 'physics', 'organic'], technique: 'webgl', inspiration: 'Chappell Roan', parameterNames: ['VISCOSITY', 'COLOR_INTENSITY'] },
  { id: 'glitter-storm', title: 'Glitter Storm', description: 'Dense field of tumbling metallic glitter flakes catching rotating spotlights with specular flash physics.', tags: ['fill', 'particles', 'physics'], technique: 'canvas-2d', inspiration: 'Chappell Roan', parameterNames: ['SPARKLE_RATE', 'DENSITY'] },
  { id: 'rubber-reality', title: 'Rubber Reality', description: 'Elastic grid mesh deformed by traveling attractors with spring physics and snap-back.', tags: ['fill', 'physics', 'geometric'], technique: 'canvas-2d', inspiration: 'Jim Carrey', parameterNames: ['ELASTICITY', 'DISTORTION_POINTS'] },
  { id: 'magma-core', title: 'Magma Core', description: 'Volcanic eruption with thermal lava particles, cooling physics, and magma pool.', tags: ['object', 'particles', 'physics'], technique: 'webgl', inspiration: 'Jack Black', parameterNames: ['ERUPTION_FORCE', 'ERUPTION_INTERVAL'] },
  { id: 'clockwork-mind', title: 'Clockwork Mind', description: 'Interlocking precision gears with metallic rendering and mathematically correct meshing.', tags: ['object', 'geometric'], technique: 'canvas-2d', inspiration: 'Robert Downey Jr.', hasHeroConfig: true, parameterNames: ['ROTATION_SPEED', 'GEAR_DETAIL'] },
  { id: 'edge-of-chaos', title: 'Edge of Chaos', description: 'Reaction-diffusion maze with golden edge glow and organic pop-and-regrow cycle.', tags: ['fill', 'organic'], technique: 'webgl', inspiration: 'Robert Downey Jr.', parameterNames: ['PATTERN_SPEED', 'POP_RATE'] },
  { id: 'spark-chamber', title: 'Spark Chamber', description: 'Charged particles spiraling through a magnetic field, leaving curved trails like cloud chamber photography.', tags: ['fill', 'particles', 'physics'], technique: 'canvas-2d', inspiration: 'Robert Downey Jr.', parameterNames: ['EMISSION_RATE', 'FIELD_STRENGTH'] },
  { id: 'shifting-veils', title: 'Shifting Veils', description: 'Layered translucent noise curtains that morph and reveal patterns underneath.', tags: ['fill', 'noise', 'organic'], technique: 'webgl', inspiration: 'Meryl Streep', parameterNames: ['LAYER_SPEED', 'LAYER_COUNT'] },
  { id: 'crystal-lattice', title: 'Crystal Lattice', description: 'Procedural crystal formations growing with faceted 3D lighting and prismatic sparkle.', tags: ['object', 'geometric'], technique: 'webgl', inspiration: 'Anne Hathaway', hasHeroConfig: true, parameterNames: ['GROWTH_SPEED', 'REFRACTION', 'TILT_X', 'TILT_Y'] },
  { id: 'kaleidoscope-runway', title: 'Kaleidoscope Runway', description: 'Fashion-inspired kaleidoscopic tessellations with symmetric mirror segments.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: 'Zendaya', parameterNames: ['SYMMETRY', 'PATTERN_SPEED'] },
  { id: 'digital-rain', title: 'Digital Rain', description: 'Warm amber character columns dissolving into zen ripples at the water surface.', tags: ['fill', 'particles'], technique: 'canvas-2d', inspiration: 'Keanu Reeves', parameterNames: ['FALL_SPEED', 'COLUMN_DENSITY'] },
  { id: 'desert-mirage', title: 'Desert Mirage', description: 'Layered parallax sand dunes with heat shimmer and wind-blown particles.', tags: ['fill', 'noise'], technique: 'canvas-2d', inspiration: 'Pedro Pascal', parameterNames: ['WIND_SPEED', 'SHIMMER_INTENSITY'] },
  { id: 'neon-drive', title: 'Neon Drive', description: 'Rain-slicked neon road stretching to a vanishing point with approaching headlights.', tags: ['fill', 'particles'], technique: 'webgl', inspiration: 'Ryan Gosling', parameterNames: ['DRIVE_SPEED', 'RAIN_INTENSITY'] },
  { id: 'liquid-gold', title: 'Liquid Gold', description: 'Molten metal flow with surface tension, metallic PBR shading, and golden reflections.', tags: ['fill', 'noise', 'organic'], technique: 'webgl', inspiration: 'Margot Robbie', parameterNames: ['FLOW_SPEED', 'VISCOSITY'] },
  { id: 'aurora-veil', title: 'Aurora Veil', description: 'Northern lights ribbons flowing above hexagonal ice crystal formations.', tags: ['fill', 'noise', 'organic'], technique: 'webgl', inspiration: 'Cate Blanchett', parameterNames: ['AURORA_SPEED', 'AURORA_INTENSITY'] },
  { id: 'bioluminescence', title: 'Bioluminescence', description: 'Deep sea jellyfish pulsing with bioluminescent glow and drifting plankton.', tags: ['fill', 'organic', 'particles'], technique: 'webgl', inspiration: 'Zendaya', defaultScheme: 'blue', parameterNames: ['GLOW_INTENSITY', 'WAVE_SPEED'] },
  { id: 'gothic-filigree', title: 'Gothic Filigree', description: 'Ornate fractal lace scrollwork growing from corners with dark metallic rendering.', tags: ['fill', 'organic', 'geometric'], technique: 'webgl', inspiration: 'Jenna Ortega', parameterNames: ['GROWTH_SPEED', 'CURL_TIGHTNESS'] },
  { id: 'laser-precision', title: 'Laser Precision', description: 'Laser beams tracing geometric patterns with spark particles and intersection flares.', tags: ['fill', 'geometric'], technique: 'canvas-2d', inspiration: 'Ana de Armas', hasHeroConfig: true, parameterNames: ['DRAW_SPEED', 'LINE_BRIGHTNESS', 'SHAPE'] },
  { id: 'magnetic-sand', title: 'Magnetic Sand', description: 'Thousands of particles aligning along invisible magnetic field lines with warm golden glow.', tags: ['fill', 'particles', 'physics'], technique: 'canvas-2d', inspiration: 'Ana de Armas', parameterNames: ['FIELD_STRENGTH', 'PARTICLE_COUNT'] },
  { id: 'woven-radiance', title: 'Woven Radiance', description: 'African textile-inspired weave patterns with vibrant kente cloth geometry.', tags: ['fill', 'geometric'], technique: 'canvas-2d', inspiration: "Lupita Nyong'o", parameterNames: ['WEAVE_SPEED', 'COLOR_RICHNESS'] },
  { id: 'jazz-chaos', title: 'Jazz Chaos', description: 'Syncopated particle groups moving in rhythm with swing timing and solos.', tags: ['fill', 'particles'], technique: 'canvas-2d', inspiration: 'Jeff Goldblum', parameterNames: ['TEMPO', 'SWING'] },
  { id: 'thunder-sermon', title: 'Thunder Sermon', description: 'Fractal lightning bolts with Lichtenberg branching and thunder shockwaves.', tags: ['fill', 'physics'], technique: 'webgl', inspiration: 'The Weeknd', parameterNames: ['STRIKE_INTERVAL', 'BRANCH_COMPLEXITY'] },
  { id: 'vinyl-grooves', title: 'Vinyl Grooves', description: 'Spinning vinyl record with visible grooves, tonearm, and needle spark.', tags: ['object', 'geometric'], technique: 'webgl', inspiration: 'Laufey', parameterNames: ['RPM', 'GROOVE_DETAIL'] },
  { id: 'vintage-static', title: 'Vintage Static', description: 'Retro TV color bars melting with VHS glitches and CRT scan lines.', tags: ['fill', 'geometric'], technique: 'canvas-2d', inspiration: 'Harry Styles', parameterNames: ['GLITCH_INTENSITY', 'MELT_SPEED'] },
  { id: 'torn-paper', title: 'Torn Paper', description: 'Paper surface tearing apart with fibrous edges revealing warm volumetric light underneath, then reforming.', tags: ['fill', 'noise', 'organic'], technique: 'webgl', inspiration: 'Olivia Rodrigo', parameterNames: ['TEAR_SPEED', 'GLOW_INTENSITY'] },
  { id: 'polaroid-burn', title: 'Polaroid Burn', description: 'Scattered polaroid photos developing warm abstract memories, overexposing, and burning out with ember edges.', tags: ['fill', 'noise'], technique: 'webgl', inspiration: 'Olivia Rodrigo', parameterNames: ['BURN_SPEED', 'PHOTO_COUNT'] },
  { id: 'scream-wave', title: 'Scream Wave', description: 'Glowing waveform building from gentle sine to distorted scream with chromatic aberration and collapse.', tags: ['object', 'physics'], technique: 'webgl', inspiration: 'Olivia Rodrigo', parameterNames: ['INTENSITY', 'WAVE_SPEED'] },
  { id: 'ink-calligraphy', title: 'Ink Calligraphy', description: 'Abstract gestural ink strokes with organic diffusion on textured paper and luminous gold leaf highlights.', tags: ['fill', 'organic'], technique: 'canvas-2d', inspiration: 'Anne Hathaway', parameterNames: ['STROKE_SPEED', 'INK_DENSITY', 'GOLD_AMOUNT', 'PALETTE'] },
  { id: 'velvet-spotlight', title: 'Velvet Spotlight', description: 'Theatrical dust particles caught in sweeping spotlight cones with volumetric rays and warm scattering haze.', tags: ['fill', 'particles'], technique: 'canvas-2d', inspiration: 'Anne Hathaway', parameterNames: ['DUST_DENSITY', 'SWEEP_SPEED'] },
  { id: 'murmuration', title: 'Murmuration', description: 'Thousands of flocking particles forming flowing ribbons with emergent density waves against a warm twilight sky.', tags: ['fill', 'particles', 'physics'], technique: 'canvas-2d', inspiration: 'Anne Hathaway', parameterNames: ['FLOCK_SIZE', 'COHESION', 'PALETTE'] },
  { id: 'tesseract-shadow', title: 'Tesseract Shadow', description: '4D hypercube projected into 2D with depth-faded wireframe, axis-mapped colors, and rotation trails.', tags: ['object', 'geometric'], technique: 'canvas-2d', inspiration: 'Benedict Cumberbatch', hasHeroConfig: true, parameterNames: ['ROTATION_SPEED', 'PROJECTION_DEPTH'] },
  { id: 'moire-interference', title: 'Moire Interference', description: 'Overlapping concentric ring patterns creating hypnotic emergent moire interference.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: 'Benedict Cumberbatch', parameterNames: ['RING_DENSITY', 'DRIFT_SPEED'] },
  { id: 'phase-transition', title: 'Phase Transition', description: 'Particles oscillating between crystalline lattice order and chaotic turbulence with a traveling phase wavefront.', tags: ['fill', 'particles', 'physics'], technique: 'canvas-2d', inspiration: 'Benedict Cumberbatch', parameterNames: ['WAVE_SPEED', 'PARTICLE_DENSITY'] },
  { id: 'magnetic-field', title: 'Magnetic Field', description: 'Dipole field lines curving between slowly rotating poles with silk-thread glow rendering.', tags: ['fill', 'geometric', 'physics'], technique: 'webgl', inspiration: 'Cate Blanchett', parameterNames: ['WAVE_SPEED', 'LINE_COUNT'] },
  { id: 'aurora-curtain', title: 'Aurora Curtain', description: 'Vertical luminous threads swaying like aurora borealis curtains with warm-to-cool color gradient.', tags: ['fill', 'organic'], technique: 'webgl', inspiration: 'Meryl Streep', parameterNames: ['WAVE_SPEED', 'LINE_COUNT', 'AMPLITUDE', 'ROTATION'] },
  { id: 'vortex', title: 'Vortex', description: 'Logarithmic spiral arms converging on a drifting center with silk-thread glow and undulating perturbation.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: "Lupita Nyong'o", parameterNames: ['WAVE_SPEED', 'LINE_COUNT'] },
  { id: 'chromatic-bloom', title: 'Chromatic Bloom', description: 'Luminous color orbs drifting on pure black with Gaussian glow, additive blending, film grain, and cinematic vignette.', tags: ['fill', 'noise'], technique: 'webgl', inspiration: 'Lady Gaga', parameterNames: ['DRIFT_SPEED', 'GRAIN_AMOUNT'] },
  { id: 'lens-whisper', title: 'Lens Whisper', description: 'Anamorphic lens flares with chromatic color separation, horizontal streaks, bokeh halos, and cinematic film grain.', tags: ['fill', 'noise'], technique: 'webgl', inspiration: 'Ryan Gosling', parameterNames: ['FLARE_SPREAD', 'DRIFT_SPEED'] },
  { id: 'luminous-silt', title: 'Luminous Silt', description: 'Dense field of 18K particles creating soft color clouds through alpha accumulation over a noise-driven flow field.', tags: ['fill', 'particles', 'noise'], technique: 'canvas-2d', inspiration: "Lupita Nyong'o", parameterNames: ['DRIFT_SPEED', 'DENSITY'] },
  { id: 'synth-ribbon', title: 'Synth Ribbon', description: 'Flowing metallic ribbons twisting through 3D space with chrome reflections in hot pink and cyan.', tags: ['fill', 'geometric'], technique: 'canvas-2d', inspiration: 'Chappell Roan', parameterNames: ['RIBBON_COUNT', 'TWIST_SPEED'] },
  { id: 'hologram-glitch', title: 'Hologram Glitch', description: 'Abstract holographic texture with chromatic aberration, scanlines, and controlled glitch bursts.', tags: ['fill', 'noise'], technique: 'webgl', inspiration: 'Daft Punk', parameterNames: ['GLITCH_INTENSITY', 'SCAN_SPEED'] },
  { id: 'shattered-plains', title: 'Shattered Plains', description: 'Storm-carved chasms branching through ancient sandstone plateaus with depth-revealed strata.', tags: ['fill', 'noise', 'organic'], technique: 'webgl', inspiration: 'Brandon Sanderson', parameterNames: ['CHANNEL_SPEED', 'CHANNEL_DEPTH', 'GRAIN'] },
  { id: 'painted-strata', title: 'Painted Strata', description: 'Flowing layered bands with washi paper textures, slow tectonic folding, and fibrous grain.', tags: ['fill', 'noise', 'organic'], technique: 'webgl', inspiration: 'Laufey', parameterNames: ['FOLD_SPEED', 'LAYER_COUNT'] },
  { id: 'feedback-loop', title: 'Feedback Loop', description: 'Recursive video feedback tunnel with holographic color cycling, geometric seed shapes, and infinite fractal depth.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: 'Daft Punk', parameterNames: ['ZOOM_SPEED', 'ROTATION_SPEED'] },
  { id: 'dither-gradient', title: 'Dither Gradient', description: 'Smooth gradients decomposed into shifting ordered dithering patterns with chromatic separation and bit-depth waves.', tags: ['fill', 'geometric'], technique: 'webgl', inspiration: 'Daft Punk', parameterNames: ['DITHER_SCALE', 'BIT_DEPTH'] },
  { id: 'analog-drift', title: 'Analog Drift', description: 'Morphing Lissajous figures with phosphor persistence trails, harmonic overtones, and oscilloscope grid.', tags: ['object', 'geometric'], technique: 'canvas-2d', inspiration: 'Daft Punk', parameterNames: ['DRIFT_SPEED', 'TRAIL_LENGTH'] },
];

// ============================================
// 9. INSPIRATION PALETTES
// ============================================

export const INSPIRATION_PALETTES: Record<string, { primary: string; colors: string[] }> = {
  'sabrina-carpenter': { primary: '#E8527A', colors: ['#E8527A', '#8B4570', '#CD6060'] },
  'laufey': { primary: '#C9A84C', colors: ['#F5E6C8', '#C9A84C', '#D4A055'] },
  'dua-lipa': { primary: '#E03A8A', colors: ['#E03A8A', '#1A3A8A', '#C0C0D0'] },
  'billie-eilish': { primary: '#6AE090', colors: ['#6AE090', '#8878AA', '#2A4A3A'] },
  'taylor-swift': { primary: '#C8964C', colors: ['#1A2A5A', '#C8964C', '#2A6A3A'] },
  'beyonce': { primary: '#D4A028', colors: ['#D4A028', '#A0522D', '#6A3D8A'] },
  'bad-bunny': { primary: '#E87460', colors: ['#A0E832', '#E87460', '#5A2D82', '#40C4AA'] },
  'sza': { primary: '#D4944C', colors: ['#D4944C', '#CC5500', '#8FAE8B'] },
  'rihanna': { primary: '#9B1B30', colors: ['#9B1B30', '#D4A028', '#FF6B35'] },
  'lady-gaga': { primary: '#C0328A', colors: ['#C0C0D0', '#C0328A', '#A080C0'] },
  'bruno-mars': { primary: '#D4A028', colors: ['#D4A028', '#CC2244', '#4A2028'] },
  'the-weeknd': { primary: '#B01030', colors: ['#B01030', '#2060CC', '#D4944C'] },
  'ariana-grande': { primary: '#C8A0B8', colors: ['#C8A0B8', '#E8D8E8', '#8A7088'] },
  'chappell-roan': { primary: '#E83878', colors: ['#E83878', '#88CC28', '#C8A038'] },
  'olivia-rodrigo': { primary: '#8A1838', colors: ['#8A1838', '#6A28AA', '#E84888'] },
  'harry-styles': { primary: '#B088CC', colors: ['#B088CC', '#E8A0A0', '#88C8A8'] },
  'jim-carrey': { primary: '#88E828', colors: ['#88E828', '#E8D828', '#2888E8'] },
  'jack-black': { primary: '#E87028', colors: ['#E87028', '#B82828', '#D4A038'] },
  'robert-downey-jr': { primary: '#4890D4', colors: ['#6A7080', '#4890D4', '#8A2838'] },
  'meryl-streep': { primary: '#7A2838', colors: ['#B0B0C0', '#606878', '#7A2838'] },
  'anne-hathaway': { primary: '#C85878', colors: ['#E8E8F0', '#C85878', '#1A2048'] },
  'zendaya': { primary: '#B07838', colors: ['#B07838', '#C08848', '#7868A0'] },
  'keanu-reeves': { primary: '#3868B0', colors: ['#181828', '#3868B0', '#C87838'] },
  'pedro-pascal': { primary: '#D4944C', colors: ['#D4944C', '#C06840', '#6A2030'] },
  'ryan-gosling': { primary: '#E86888', colors: ['#E86888', '#3868CC', '#C89078'] },
  'margot-robbie': { primary: '#E888A8', colors: ['#E888A8', '#D4A028', '#CC2828'] },
  'cate-blanchett': { primary: '#B0B8D0', colors: ['#B0B0C0', '#B0B8D0', '#8898C0'] },
  'jenna-ortega': { primary: '#5A2858', colors: ['#282030', '#5A2858', '#A0A0B8'] },
  'ana-de-armas': { primary: '#D4A038', colors: ['#D4A038', '#E8E0D0', '#8A7838'] },
  'lupita-nyong-o': { primary: '#2858CC', colors: ['#2858CC', '#D4A028', '#5A2880'] },
  'jeff-goldblum': { primary: '#E87868', colors: ['#181838', '#E87868', '#7A2030'] },
  'benedict-cumberbatch': { primary: '#C8A050', colors: ['#C8A050', '#E8C870', '#785020'] },
  'daft-punk': { primary: '#50C8D0', colors: ['#50C8D0', '#C0C0D0', '#D4A040'] },
  'brandon-sanderson': { primary: '#B08040', colors: ['#B08040', '#6A4828', '#D4A868'] },
};

// ============================================
// 10. LAYOUT TEMPLATES (from source-templates.ts)
// ============================================

export const LAYOUT_TEMPLATES = {
  heroSectionSplit: {
    description: 'Two-column hero: content left (flex: 1), shader right (flex: 0 0 420px, aspect-ratio: 4/3). Nav bar above with logo and links. Content: h1 (2.5rem, weight 500), paragraph (rgba text), CTA button (amber solid).',
    navStyle: 'flex, justify-between, padding: 1.5rem 3rem, logo: weight 600 amber, links: 0.9rem muted',
    heroStyle: 'flex, align-center, gap: 3rem, padding: 3rem, max-width: 1200px, min-height: 60vh',
  },
  heroSectionFullBleed: {
    description: 'Full-viewport shader background with content overlaid. Shader in fixed position behind page content. Nav and content in relative z-index layer.',
    shaderBackground: 'position: fixed, inset: 0, z-index: 0',
    pageContent: 'position: relative, z-index: 1, min-height: 100vh, flex column',
    heroContent: 'max-width: 600px, padding: 3rem',
  },
  backgroundOverlay: {
    description: 'Full-viewport shader with dark overlay (rgba(10,10,10,0.7)) and centered content. Good for call-to-action screens.',
    overlay: 'position: absolute, inset: 0, flex column, center content, background: rgba(10,10,10,0.7)',
    headingSize: '3rem',
    ctaStyle: 'padding: 0.75rem 2rem, amber solid, rounded 6px',
  },
  accentSplit: {
    description: 'Content left (max-width: 40%), shader right with CSS mask fade. Shader positioned at left: 50%, masked with gradient from transparent to opaque.',
    maskImage: 'linear-gradient(to right, transparent 0%, black 40%)',
    contentPadding: '4rem',
    contentMaxWidth: '40%',
  },
} as const;

// ============================================
// USAGE NOTES
// ============================================

/**
 * HOW TO USE THIS REFERENCE:
 *
 * 1. COLOR: Start with COLOR_PATTERNS.corePalette for the base dark theme.
 *    Apply color schemes via CSS filter for instant mood changes.
 *    Use the opacity scale for text hierarchy without adding colors.
 *
 * 2. LAYOUT: Use LAYOUT_PATTERNS.grids for responsive grid setups.
 *    The gallery grid (auto-fill, minmax 380px) is the go-to for card layouts.
 *    Sidebars are 240px, sticky, with custom scrollbar.
 *
 * 3. ANIMATION: Keep transitions fast (0.15-0.3s). The breathing glow (20s) is
 *    for ambient background elements only. Always respect prefers-reduced-motion.
 *    Use lerp smoothing (rate 0.06) for drag/cursor interactions.
 *
 * 4. COMPONENTS: Cards lift 2px on hover with border brightening. Buttons use
 *    two types (solid amber, ghost amber). Navigation is glass-morphism (blur + transparency).
 *    Range sliders are custom-styled with amber thumbs.
 *
 * 5. TYPOGRAPHY: Inter 300-600. Headings at 300 weight (light, premium).
 *    Uppercase labels with wide letter-spacing for section structure.
 *    Hero uses fluid clamp() type.
 *
 * 6. EFFECTS: Glass-morphism (backdrop-filter: blur(12px)) is the signature effect.
 *    All borders are 1px amber at 0.06-0.25 opacity. Custom scrollbars everywhere.
 *    Color filters on iframes for instant scheme switching.
 *
 * 7. RESPONSIVE: 640px (mobile), 768px (tablet/sidebar), 900px (grid).
 *    Mobile: single column, centered hero, hidden sidebar becomes drawer.
 *    All interactive controls adapt (hide labels, shrink inputs).
 *
 * 8. SHADERS: 94 shaders across Canvas 2D and WebGL. Each is self-contained HTML.
 *    Parameters controllable via postMessage. All support pause/resume.
 *    Tags: fill, object, particles, physics, noise, organic, geometric.
 *
 * KEY DESIGN PRINCIPLES FROM RADIANT:
 * - Near-black backgrounds (#0a0a0a) with warm amber accent (#c8956c)
 * - Opacity-based hierarchy (13 steps from 1.0 to 0.06)
 * - Glass-morphism for floating UI elements
 * - Generous whitespace with thin amber borders for definition
 * - Light font weights (300) for headings, creating an airy premium feel
 * - Uppercase micro-labels for structural elements
 * - CSS filter chains for color theming without modifying content
 * - Sprite sheets for instant preview without rendering overhead
 * - Intersection Observer for lazy loading and visibility-based optimization
 * - postMessage API for iframe-embedded content control
 */
