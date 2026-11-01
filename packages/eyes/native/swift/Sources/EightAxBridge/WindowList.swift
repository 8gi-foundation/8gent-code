// 8gent AX bridge - window enumeration.
//
// Conceptual ancestor: Peekaboo (MIT, Copyright 2025 Peter Steinberger)
//   Core/PeekabooAutomationKit/Sources/PeekabooAutomationKit/Utilities/
//     WindowListMapper.swift
// Modified for 8gent: replaces PeekabooFoundation types with plain
// dictionaries matching the JSON shape the TS adapter already parses
// (packages/eyes/utils/display.ts FrontWindowData). Uses
// CGWindowListCopyWindowInfo directly.

import AppKit
import CoreGraphics
import Foundation

enum WindowList {
    static func run(args: [String: Any]) {
        let appFilter = args["app"] as? String

        // CGWindowListCopyWindowInfo returns on-screen windows in z-order
        // (front to back). For "frontmost" we filter to the foreground app
        // and take its top window.
        let listOptions: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(listOptions, kCGNullWindowID) as? [[String: Any]] else {
            emit(envelope: .failure(code: "WINDOW_ENUM", message: "CGWindowListCopyWindowInfo returned nil"))
            return
        }

        let frontmostApp: NSRunningApplication? = {
            if appFilter == "frontmost" {
                return NSWorkspace.shared.frontmostApplication
            }
            if let bundleID = appFilter {
                return NSWorkspace.shared.runningApplications
                    .first { $0.bundleIdentifier == bundleID }
            }
            return nil
        }()

        let mapped: [[String: Any]] = raw.compactMap { entry -> [String: Any]? in
            guard let pid = entry[kCGWindowOwnerPID as String] as? pid_t else { return nil }
            if let app = frontmostApp, pid != app.processIdentifier {
                return nil
            }

            let appName = entry[kCGWindowOwnerName as String] as? String
            let title = entry[kCGWindowName as String] as? String

            // CGRect bounds dictionary: { X, Y, Width, Height } in global coords.
            let boundsDict = entry[kCGWindowBounds as String] as? [String: Any]
            let bx = (boundsDict?["X"] as? CGFloat) ?? 0
            let by = (boundsDict?["Y"] as? CGFloat) ?? 0
            let bw = (boundsDict?["Width"] as? CGFloat) ?? 0
            let bh = (boundsDict?["Height"] as? CGFloat) ?? 0

            let windowID = entry[kCGWindowNumber as String] as? Int ?? -1
            let layer = entry[kCGWindowLayer as String] as? Int ?? 0

            return [
                "windowID": windowID,
                "pid": Int(pid),
                "app": appName ?? "",
                "title": title ?? "",
                "layer": layer,
                "bounds": [
                    "x": bx,
                    "y": by,
                    "width": bw,
                    "height": bh,
                ],
            ]
        }

        // For frontmost, the top non-zero-layer window is the active one.
        let filtered: [[String: Any]] = {
            guard appFilter == "frontmost" else { return mapped }
            // Prefer non-floating layer windows; floating panels are layer != 0.
            let normal = mapped.filter { ($0["layer"] as? Int) == 0 }
            if let top = normal.first { return [top] }
            if let top = mapped.first { return [top] }
            return []
        }()

        emit(envelope: .success([
            "windows": filtered,
        ]))
    }
}
