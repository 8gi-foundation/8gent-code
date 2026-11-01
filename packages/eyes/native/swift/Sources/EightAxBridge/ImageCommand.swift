// 8gent AX bridge - screen capture.
//
// Conceptual ancestor: Peekaboo (MIT, Copyright 2025 Peter Steinberger)
//   Core/PeekabooAutomationKit/Sources/PeekabooAutomationKit/Services/Capture/
//     LegacyScreenCaptureOperator+ScreenArea.swift
// Modified for 8gent: drops PeekabooFoundation/AXorcist dependencies, uses
// /usr/sbin/screencapture as the primary capture path (no entitlement
// negotiation, works headlessly when Screen Recording is granted) with a
// CGDisplayCreateImage fallback. Output JSON shape mirrors what the TS
// adapter (packages/eyes/backends/peekaboo.ts PeekabooImageData) parses.
//
// Inputs (JSON args):
//   mode: "screen" | "area"   (default "screen")
//   screenIndex: Int           (NSScreen index; 0 = primary)
//   path: String               (output PNG/JPG path)
//   format: "png" | "jpg"
//   region: "x,y,w,h"          (logical pixels, global coords; required for "area")

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum ImageCommand {
    static func run(args: [String: Any]) {
        let mode = (args["mode"] as? String) ?? "screen"
        let format = (args["format"] as? String) ?? "png"
        guard let outputPath = args["path"] as? String, !outputPath.isEmpty else {
            emit(envelope: .failure(code: "USAGE", message: "image: --path is required"))
            return
        }

        switch mode {
        case "screen":
            captureScreen(args: args, format: format, outputPath: outputPath)
        case "area":
            captureArea(args: args, format: format, outputPath: outputPath)
        default:
            emit(envelope: .failure(code: "USAGE", message: "image: unsupported mode '\(mode)'"))
        }
    }

    // MARK: - Screen mode

    private static func captureScreen(args: [String: Any], format: String, outputPath: String) {
        let screens = NSScreen.screens
        guard !screens.isEmpty else {
            emit(envelope: .failure(code: "NO_DISPLAY", message: "no displays available"))
            return
        }

        let index: Int = (args["screenIndex"] as? Int) ?? 0
        guard index >= 0, index < screens.count else {
            emit(envelope: .failure(
                code: "INVALID_DISPLAY",
                message: "screenIndex \(index) out of range 0..\(screens.count - 1)"
            ))
            return
        }
        let target = screens[index]
        let bounds = target.frame

        // Try /usr/sbin/screencapture first - most reliable, honours Screen
        // Recording grant cleanly, no SCK gating ceremony.
        if let producedPath = systemScreencaptureFullDisplay(
            displayID: target.displayID,
            outputPath: outputPath,
            format: format
        ) {
            emitImageSuccess(path: producedPath, format: format, bounds: bounds, scale: target.backingScaleFactor)
            return
        }

        // Fallback: CGDisplayCreateImage (deprecated on 14.4+ but still works).
        guard let cgImage = CGDisplayCreateImage(target.displayID) else {
            emit(envelope: .failure(code: "CAPTURE_FAILED", message: "CGDisplayCreateImage returned nil; check Screen Recording permission"))
            return
        }
        guard writeCGImage(cgImage, to: outputPath, format: format) else {
            emit(envelope: .failure(code: "WRITE_FAILED", message: "failed to write capture to \(outputPath)"))
            return
        }
        emitImageSuccess(path: outputPath, format: format, bounds: bounds, scale: target.backingScaleFactor)
    }

    // MARK: - Area mode

    private static func captureArea(args: [String: Any], format: String, outputPath: String) {
        guard let regionStr = args["region"] as? String else {
            emit(envelope: .failure(code: "USAGE", message: "image area: --region 'x,y,w,h' required"))
            return
        }
        let parts = regionStr.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 4 else {
            emit(envelope: .failure(code: "USAGE", message: "image area: --region must be 'x,y,width,height'"))
            return
        }
        let rect = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])

        // /usr/sbin/screencapture handles area capture across displays and
        // accounts for DPI; prefer it.
        if let producedPath = systemScreencaptureArea(rect: rect, outputPath: outputPath, format: format) {
            // Find which display the region center is in for metadata.
            let cx = rect.midX, cy = rect.midY
            let display = NSScreen.screens.first { $0.frame.contains(CGPoint(x: cx, y: cy)) } ?? NSScreen.screens.first
            let scale = display?.backingScaleFactor ?? 1.0
            emitImageSuccess(path: producedPath, format: format, bounds: rect, scale: scale)
            return
        }
        emit(envelope: .failure(code: "CAPTURE_FAILED", message: "system screencapture failed for area"))
    }

    // MARK: - Helpers

    private static func systemScreencaptureFullDisplay(
        displayID: CGDirectDisplayID,
        outputPath: String,
        format: String
    ) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        // -x silent, -D <id> selects display, -t <format> selects format
        // CGDirectDisplayID is opaque; screencapture accepts 1-based display
        // indices via -D, derived from the position in CGGetActiveDisplayList.
        let displayArgIndex = activeDisplayIndex(for: displayID)
        var argv = ["-x", "-t", format == "jpg" ? "jpg" : "png"]
        if let idx = displayArgIndex {
            // screencapture -D is 1-based.
            argv.append("-D")
            argv.append("\(idx + 1)")
        }
        argv.append(outputPath)
        process.arguments = argv
        do {
            try process.run()
        } catch {
            return nil
        }
        process.waitUntilExit()
        if process.terminationStatus == 0, FileManager.default.fileExists(atPath: outputPath) {
            return outputPath
        }
        return nil
    }

    private static func systemScreencaptureArea(rect: CGRect, outputPath: String, format: String) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        let regionArg = "-R\(Int(rect.minX.rounded(.down))),\(Int(rect.minY.rounded(.down))),\(Int(rect.width.rounded(.toNearestOrAwayFromZero))),\(Int(rect.height.rounded(.toNearestOrAwayFromZero)))"
        process.arguments = ["-x", "-t", format == "jpg" ? "jpg" : "png", regionArg, outputPath]
        do {
            try process.run()
        } catch {
            return nil
        }
        process.waitUntilExit()
        if process.terminationStatus == 0, FileManager.default.fileExists(atPath: outputPath) {
            return outputPath
        }
        return nil
    }

    private static func activeDisplayIndex(for target: CGDirectDisplayID) -> Int? {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return nil }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return nil }
        return ids.firstIndex(of: target)
    }

    private static func writeCGImage(_ image: CGImage, to path: String, format: String) -> Bool {
        let url = URL(fileURLWithPath: path)
        let utType: CFString = format == "jpg" ? UTType.jpeg.identifier as CFString : UTType.png.identifier as CFString
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, utType, 1, nil) else { return false }
        CGImageDestinationAddImage(dest, image, nil)
        return CGImageDestinationFinalize(dest)
    }

    private static func emitImageSuccess(path: String, format: String, bounds: CGRect, scale: CGFloat) {
        let mime = format == "jpg" ? "image/jpeg" : "image/png"
        emit(envelope: .success([
            "files": [[
                "path": path,
                "mime_type": mime,
                "window_id": NSNull(),
                "window_title": NSNull(),
                "item_label": NSNull(),
                "window_index": NSNull(),
                "logical_size": [
                    "width": bounds.width,
                    "height": bounds.height,
                ],
                "scale_factor": scale,
            ]],
        ]))
    }
}
