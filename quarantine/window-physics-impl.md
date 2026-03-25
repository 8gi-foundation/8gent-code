# Window Physics Implementation

**Status:** Quarantine - ready for integration into PetController
**File:** `apps/lil-eight/LilEight/WindowPhysics.swift`
**Lines:** ~200
**Touches:** 1 new file (no existing files modified)

## Problem

Lil Eight currently walks on the Dock bar only. The pet has basic gravity that always pulls it back to `homeY` (dock level). It cannot interact with visible application windows.

## Approach

### Surface detection via CGWindowListCopyWindowInfo

We poll visible on-screen windows and extract their bounding rectangles. Each window's top edge becomes a walkable `Surface`. The pet falls under gravity until it lands on the highest surface beneath its center point.

**Why CGWindowListCopyWindowInfo:** This API is deprecated in macOS 15, but it remains the only way to enumerate all visible window geometries without ScreenCaptureKit entitlements or per-app Accessibility trust. When Apple ships a geometry-only replacement, migration is a single function swap inside `refreshSurfaces()`.

**Why not Accessibility API:** AXUIElement requires the target app to be trusted for accessibility. This would require the user to grant permissions for every app whose windows the pet should walk on - not practical.

### Coordinate system

macOS has two coordinate systems:
- **CoreGraphics:** Origin at top-left of primary display, Y grows downward
- **Cocoa (AppKit):** Origin at bottom-left of primary display, Y grows upward

`CGWindowListCopyWindowInfo` returns CG coords. We convert to Cocoa coords so the pet's NSWindow frame and the surface Y values are in the same space:

```
cocoaTopEdgeY = screenHeight - cgY
```

### Physics model

Per-tick (called from PetController's animation timer at ~6.7 Hz):

1. Apply gravity: `velocity.y -= gravity` (capped at terminal velocity)
2. Update position: `position.y += velocity.y`
3. Surface collision: find the highest surface where the pet's bottom is within snap tolerance of the surface Y
4. Floor clamp: the Dock level is the absolute minimum Y
5. Edge clamping: if on a surface, keep the pet within `[surface.minX, surface.maxX - petWidth]`

### Polling strategy

Window positions are re-scanned every 0.5 seconds (configurable). This keeps CPU usage negligible while still responding to window moves/resizes within a human-perceptible timeframe.

### Filtering

- Only layer-0 windows (standard app windows, not menu bar items or overlays)
- Excludes windows smaller than 100x40 px (menu extras, status items)
- Excludes the pet's own windows via `registerOwnWindows()`
- Excludes desktop elements via `excludeDesktopElements` flag

## Integration (not yet wired)

To integrate into PetController, the following changes would be needed in `main.swift`:

```swift
// In PetController.init:
let physics = WindowPhysics(dockY: homeY)
physics.registerOwnWindows([window.windowNumber, nameLabel.windowNumber])

// Replace the gravity block in advanceFrame() with:
var velocity = CGPoint(x: 0, y: currentVelocityY)
let result = physics.resolve(
    petRect: window.frame,
    velocity: velocity,
    isDragging: isDragging
)
posY = result.position.y
currentVelocityY = result.velocity.y

// Use edge detection to reverse walk direction:
if let surface = result.currentSurface {
    let edge = physics.edgeProximity(petX: posX, surface: surface)
    if edge != 0 {
        walkDirection = -walkDirection
    }
}
```

## What this does NOT do

- Does not modify main.swift or any existing file
- Does not handle multi-monitor surface stitching (surfaces are per-screen)
- Does not animate falling (the sprite animation system handles that separately)
- Does not use ScreenCaptureKit (would require entitlement changes to Info.plist)

## Success metric

Pet lands on the top edge of any visible window and walks along it, falling off edges with gravity and landing on lower windows or the Dock.
