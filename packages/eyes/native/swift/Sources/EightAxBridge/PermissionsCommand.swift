// 8gent AX bridge - permission probe.
//
// Conceptual ancestor: Peekaboo (MIT, Copyright 2025 Peter Steinberger)
//   Core/PeekabooAutomationKit/Sources/PeekabooAutomationKit/Services/System/
//     PermissionsService.swift
// Modified for 8gent: drops Logger + AppleScript probing (out of scope for
// the eyes capability; eyes only needs Screen Recording + Accessibility).
// Uses CGPreflightScreenCaptureAccess + AXIsProcessTrusted directly.
//
// Output JSON shape matches what the TS adapter
// (packages/eyes/backends/peekaboo.ts probePermissions) parses:
//   { permissions: [{ name, isRequired, isGranted, grantInstructions? }] }

import ApplicationServices
import CoreGraphics
import Foundation

enum PermissionsCommand {
    static func run() {
        let screenRecording = checkScreenRecording()
        let accessibility = AXIsProcessTrusted()

        let payload: [[String: Any]] = [
            [
                "name": "Screen Recording",
                "isRequired": true,
                "isGranted": screenRecording,
                "grantInstructions": "System Settings > Privacy & Security > Screen Recording > enable for your terminal or 8gent app",
            ],
            [
                "name": "Accessibility",
                "isRequired": true,
                "isGranted": accessibility,
                "grantInstructions": "System Settings > Privacy & Security > Accessibility > enable for your terminal or 8gent app",
            ],
        ]

        emit(envelope: .success([
            "permissions": payload,
        ]))
    }

    /// CGPreflightScreenCaptureAccess can be unreliable in CLI contexts
    /// (returns false until first capture attempt). We treat its result as
    /// a hint and let the caller surface "missing entitlement" if a real
    /// capture later fails.
    private static func checkScreenRecording() -> Bool {
        if #available(macOS 10.15, *) {
            return CGPreflightScreenCaptureAccess()
        }
        return true
    }
}
