// 8gent AX bridge - screen enumeration.
//
// Conceptual ancestor: Peekaboo (MIT, Copyright 2025 Peter Steinberger)
//   Apps/CLI/Sources/PeekabooCLI/Commands/Core/ListCommand+Screens.swift
// Modified for 8gent: drops PeekabooCore service dispatch, calls
// CGGetActiveDisplayList + NSScreen directly, emits the JSON shape the
// existing TS adapter (packages/eyes/utils/display.ts) already expects.

import AppKit
import CoreGraphics
import Foundation

enum ScreenList {
    static func run() {
        let screens = NSScreen.screens
        let primary = NSScreen.screens.first
        let primaryDisplayID = primary?.displayID

        let payload: [[String: Any]] = screens.enumerated().map { index, screen in
            let displayID = screen.displayID
            let bounds = screen.frame
            let scale = screen.backingScaleFactor
            return [
                "index": index,
                "displayID": Int(displayID),
                "name": screen.localizedName.isEmpty ? "Display \(index)" : screen.localizedName,
                "isPrimary": displayID == primaryDisplayID,
                "scaleFactor": scale,
                "position": [
                    "x": bounds.origin.x,
                    "y": bounds.origin.y,
                ],
                "resolution": [
                    "width": bounds.width,
                    "height": bounds.height,
                ],
                "visibleArea": [
                    "width": screen.visibleFrame.width,
                    "height": screen.visibleFrame.height,
                ],
            ]
        }

        let primaryIndex = screens.firstIndex { $0.displayID == primaryDisplayID } ?? 0
        emit(envelope: .success([
            "screens": payload,
            "primaryIndex": primaryIndex,
        ]))
    }
}

// NSScreen.displayID is a private convention; expose via the documented
// deviceDescription key. CGDirectDisplayID is a UInt32; surfaces above use Int.
extension NSScreen {
    var displayID: CGDirectDisplayID {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        guard let number = deviceDescription[key] as? NSNumber else { return 0 }
        return CGDirectDisplayID(number.uint32Value)
    }
}
