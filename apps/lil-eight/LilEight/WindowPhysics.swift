import Cocoa
import CoreGraphics

// MARK: - Window Surface Physics for Lil Eight
//
// Lets the pet walk on top of visible windows. Polls the Accessibility API
// to build a surface map from window top-edges, then applies gravity and
// edge clamping so the pet lands on windows instead of falling to the Dock.
//
// Usage from PetController:
//   let physics = WindowPhysics()
//   // In advanceFrame():
//   let result = physics.resolve(petRect: window.frame, velocity: velocity)
//   posY = result.position.y
//   velocity = result.velocity

// MARK: - Types

/// A walkable surface derived from the top edge of a window.
struct Surface: Equatable {
    let minX: CGFloat
    let maxX: CGFloat
    let y: CGFloat          // top-edge Y in screen coords (Cocoa: 0 = bottom)
    let windowID: CGWindowID

    var width: CGFloat { maxX - minX }

    /// Whether a horizontal position falls within this surface (with margin).
    func contains(x: CGFloat, margin: CGFloat = 4) -> Bool {
        x >= (minX - margin) && x <= (maxX + margin)
    }
}

/// Result of a single physics tick.
struct PhysicsResult {
    var position: CGPoint   // new pet origin (bottom-left, Cocoa coords)
    var velocity: CGPoint
    var onSurface: Bool
    var currentSurface: Surface?
}

// MARK: - WindowPhysics

/// Polls visible windows and resolves pet position against their top edges.
///
/// Design notes:
/// - CGWindowListCopyWindowInfo is deprecated in macOS 15 but the Accessibility
///   API only exposes windows for apps with AXUIElement trust. We use the CG
///   call with a deprecation silencer and will migrate to ScreenCaptureKit
///   window enumeration when it gains geometry-only queries.
/// - Polling happens on a configurable interval (default 0.5s) to keep CPU low.
/// - The surface list is sorted top-to-bottom so the pet lands on the highest
///   surface under its feet first.
class WindowPhysics {

    // MARK: Configuration

    /// Gravity acceleration in points per tick (positive = downward in logic,
    /// but subtracted from Y in Cocoa coords where Y grows upward).
    var gravity: CGFloat = 1.2

    /// Terminal velocity (max fall speed per tick).
    var terminalVelocity: CGFloat = 12.0

    /// How often to re-scan windows (seconds).
    var pollInterval: TimeInterval = 0.5

    /// Pet sprite width used for edge detection.
    var petWidth: CGFloat = 64.0

    /// Pet sprite height - used to detect surface contact zone.
    var petHeight: CGFloat = 64.0

    /// Snap tolerance: if pet is within this many points of a surface, snap to it.
    var snapTolerance: CGFloat = 8.0

    /// The Dock-level Y - the absolute floor.
    var dockY: CGFloat

    // MARK: State

    private(set) var surfaces: [Surface] = []
    private var lastPollTime: Date = .distantPast
    private var ownWindowIDs: Set<CGWindowID> = []

    // MARK: Init

    init(dockY: CGFloat? = nil) {
        if let dockY = dockY {
            self.dockY = dockY
        } else {
            let screen = NSScreen.main ?? NSScreen.screens.first!
            self.dockY = screen.frame.minY + 70 // default Dock height estimate
        }
    }

    // MARK: - Public API

    /// Register window IDs that belong to the pet so they are excluded from surfaces.
    func registerOwnWindows(_ ids: [CGWindowID]) {
        ownWindowIDs = Set(ids)
    }

    /// Main per-tick entry point. Call from the animation timer.
    ///
    /// - Parameters:
    ///   - petRect: Current pet window frame (Cocoa coords, origin = bottom-left).
    ///   - velocity: Current velocity vector (positive Y = upward in Cocoa).
    ///   - isDragging: Skip physics while dragging.
    /// - Returns: Updated position, velocity, and surface info.
    func resolve(petRect: NSRect, velocity: CGPoint, isDragging: Bool = false) -> PhysicsResult {
        // Re-scan windows if poll interval elapsed
        let now = Date()
        if now.timeIntervalSince(lastPollTime) >= pollInterval {
            refreshSurfaces()
            lastPollTime = now
        }

        if isDragging {
            return PhysicsResult(
                position: petRect.origin,
                velocity: .zero,
                onSurface: false,
                currentSurface: nil
            )
        }

        var pos = petRect.origin
        var vel = velocity

        // Apply gravity (Cocoa: Y up, so gravity subtracts)
        vel.y = max(vel.y - gravity, -terminalVelocity)
        pos.y += vel.y

        // Find the best surface under the pet
        let petCenterX = pos.x + petWidth / 2.0
        let petBottom = pos.y

        var landed = false
        var landedSurface: Surface?

        for surface in surfaces {
            // Surface must be horizontally reachable
            guard surface.contains(x: petCenterX, margin: petWidth * 0.3) else { continue }

            // Surface Y must be at or below where the pet currently is
            // (pet is falling through or near the surface)
            let surfaceTop = surface.y

            if petBottom <= surfaceTop + snapTolerance && petBottom >= surfaceTop - petHeight {
                // Pet is at or just below surface level - land on it
                pos.y = surfaceTop
                vel.y = 0
                landed = true
                landedSurface = surface
                break
            }
        }

        // Floor: the Dock level is the absolute minimum
        if pos.y <= dockY {
            pos.y = dockY
            vel.y = 0
            landed = true
            // No surface object for the dock - it's implicit
        }

        // Edge clamping: if on a surface, don't walk off the edge
        if let surface = landedSurface {
            let leftEdge = surface.minX
            let rightEdge = surface.maxX - petWidth
            if pos.x < leftEdge {
                pos.x = leftEdge
            } else if pos.x > rightEdge {
                pos.x = rightEdge
            }
        }

        return PhysicsResult(
            position: pos,
            velocity: vel,
            onSurface: landed,
            currentSurface: landedSurface
        )
    }

    /// Force an immediate surface refresh (useful after drag-end).
    func forceRefresh() {
        refreshSurfaces()
        lastPollTime = Date()
    }

    /// Check if a pet at the given X would be near a surface edge.
    /// Returns direction to reverse: -1 (near left edge), +1 (near right edge), 0 (safe).
    func edgeProximity(petX: CGFloat, surface: Surface, margin: CGFloat = 8) -> CGFloat {
        if petX - surface.minX < margin { return -1 }
        if surface.maxX - (petX + petWidth) < margin { return 1 }
        return 0
    }

    // MARK: - Surface Scanning

    private func refreshSurfaces() {
        var newSurfaces: [Surface] = []

        // CGWindowListCopyWindowInfo is deprecated in macOS 15 but there is no
        // 1:1 replacement that provides geometry without ScreenCaptureKit
        // entitlements. Suppress the warning until Apple ships an alternative.
        let windowList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[CFString: Any]] ?? []

        let screenHeight = NSScreen.main?.frame.height ?? 1080

        for info in windowList {
            // Filter: only standard windows (layer 0), skip our own
            guard let layer = info[kCGWindowLayer] as? Int, layer == 0 else { continue }
            guard let windowID = info[kCGWindowNumber] as? CGWindowID else { continue }
            guard !ownWindowIDs.contains(windowID) else { continue }

            // Skip tiny windows (toolbars, popups)
            guard let boundsDict = info[kCGWindowBounds] as? [String: CGFloat] else { continue }
            guard let cgX = boundsDict["X"],
                  let cgY = boundsDict["Y"],
                  let cgW = boundsDict["Width"],
                  let cgH = boundsDict["Height"] else { continue }

            // Skip windows smaller than 100px wide (menu extras, status items)
            guard cgW >= 100 && cgH >= 40 else { continue }

            // Convert from CG coords (origin top-left) to Cocoa (origin bottom-left)
            // CG top-left Y -> Cocoa bottom-left: cocoaY = screenHeight - cgY - cgH
            // The TOP edge of the window in Cocoa coords:
            let topEdgeY = screenHeight - cgY

            let surface = Surface(
                minX: cgX,
                maxX: cgX + cgW,
                y: topEdgeY,
                windowID: windowID
            )
            newSurfaces.append(surface)
        }

        // Sort surfaces top-to-bottom (highest Y first) so the pet lands on
        // the topmost reachable surface.
        newSurfaces.sort { $0.y > $1.y }

        surfaces = newSurfaces
    }
}
