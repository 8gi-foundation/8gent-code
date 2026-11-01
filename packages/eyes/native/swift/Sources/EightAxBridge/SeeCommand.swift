// 8gent AX bridge - capture + AX tree annotation.
//
// Conceptual ancestor: Peekaboo (MIT, Copyright 2025 Peter Steinberger)
//   Core/PeekabooAutomationKit/Sources/PeekabooAutomationKit/Services/UI/
//     AutomationElement.swift
//   Core/PeekabooAutomationKit/Sources/PeekabooAutomationKit/Services/UI/
//     AXDescriptorReader.swift
//   Core/PeekabooAutomationKit/Sources/PeekabooAutomationKit/Services/UI/
//     AXTreeCollector.swift
// Modified for 8gent: replaces AXorcist wrapper with the public AXUIElement
// C API directly, drops Logger/CommandRuntime ceremony, emits the JSON shape
// the existing TS adapter (packages/eyes/backends/peekaboo.ts PeekabooSeeData)
// already parses. Walks the system-wide AX tree under the focused
// application, depth-bounded for safety.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

enum SeeCommand {
    static func run(args: [String: Any]) {
        // Step 1: capture screen for the snapshot reference.
        let outputPath = (args["path"] as? String) ?? defaultSnapshotPath()
        let screenIndex = (args["screenIndex"] as? Int) ?? 0
        let screens = NSScreen.screens
        guard !screens.isEmpty else {
            emit(envelope: .failure(code: "NO_DISPLAY", message: "no displays available"))
            return
        }
        let target = screens[min(max(screenIndex, 0), screens.count - 1)]

        // Reuse ImageCommand pathway by calling /usr/sbin/screencapture inline;
        // duplicating one-liner to keep modules cohesive.
        let argv = ["/usr/sbin/screencapture", "-x", "-t", "png",
                    "-D", "\(displayArgIndex(for: target.displayID) ?? 0)", outputPath]
        let process = Process()
        process.executableURL = URL(fileURLWithPath: argv[0])
        process.arguments = Array(argv.dropFirst())
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            emit(envelope: .failure(code: "CAPTURE_FAILED", message: "screencapture failed: \(error.localizedDescription)"))
            return
        }
        guard FileManager.default.fileExists(atPath: outputPath) else {
            emit(envelope: .failure(code: "CAPTURE_FAILED", message: "screencapture produced no file (check Screen Recording permission)"))
            return
        }

        // Step 2: walk the AX tree under the frontmost app.
        guard AXIsProcessTrusted() else {
            emit(envelope: .failure(code: "PERM_AX", message: "Accessibility permission not granted; grant in System Settings > Privacy & Security > Accessibility"))
            return
        }

        let frontApp = NSWorkspace.shared.frontmostApplication
        let appName = frontApp?.localizedName
        let pid = frontApp?.processIdentifier ?? 0

        var elements: [[String: Any]] = []
        var windowTitle: String?

        if pid > 0 {
            let appElement = AXUIElementCreateApplication(pid)
            // Get the focused window first; fall back to first window.
            var focusedWindow: AXUIElement?
            if let w: AXUIElement = axCopyAttribute(appElement, kAXFocusedWindowAttribute as CFString) {
                focusedWindow = w
            } else if let windows: [AXUIElement] = axCopyAttribute(appElement, kAXWindowsAttribute as CFString) {
                focusedWindow = windows.first
            }
            if let window = focusedWindow {
                windowTitle = axCopyAttribute(window, kAXTitleAttribute as CFString)
                let collector = AxTreeCollector()
                collector.walk(element: window, depth: 0, parentLabel: nil)
                elements = collector.elements
            }
        }

        let interactable = elements.filter { ($0["is_actionable"] as? Bool) == true }.count
        let snapshotID = "snap_\(Int(Date().timeIntervalSince1970 * 1000))"

        emit(envelope: .success([
            "snapshot_id": snapshotID,
            "screenshot_raw": outputPath,
            "screenshot_annotated": outputPath,
            "ui_map": NSNull(),
            "application_name": appName as Any? ?? NSNull(),
            "window_title": windowTitle as Any? ?? NSNull(),
            "is_dialog": false,
            "element_count": elements.count,
            "interactable_count": interactable,
            "capture_mode": "screen",
            "execution_time": 0,
            "ui_elements": elements,
        ]))
    }

    private static func defaultSnapshotPath() -> String {
        let dir = NSTemporaryDirectory().appending("8gent-eyes-bridge")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return "\(dir)/see_\(Int(Date().timeIntervalSince1970 * 1000)).png"
    }

    private static func displayArgIndex(for displayID: CGDirectDisplayID) -> Int? {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return nil }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return nil }
        if let idx = ids.firstIndex(of: displayID) { return idx + 1 }
        return nil
    }
}

// MARK: - AX tree collector

/// Walks an AX subtree breadth-first up to a depth bound and emits flat
/// element descriptors that match the TS PeekabooSeeData.ui_elements shape.
final class AxTreeCollector {
    var elements: [[String: Any]] = []
    private let maxDepth = 12
    private let maxElements = 500
    private var counter = 0

    func walk(element: AXUIElement, depth: Int, parentLabel: String?) {
        guard depth <= maxDepth, elements.count < maxElements else { return }

        let role: String = axCopyAttribute(element, kAXRoleAttribute as CFString) ?? "AXUnknown"
        let title: String? = axCopyAttribute(element, kAXTitleAttribute as CFString)
        let label: String? = axCopyAttribute(element, kAXDescriptionAttribute as CFString)
        let value: String? = axCopyValueAsString(element)
        let help: String? = axCopyAttribute(element, kAXHelpAttribute as CFString)
        let identifier: String? = axCopyAttribute(element, kAXIdentifierAttribute as CFString)
        let roleDescription: String? = axCopyAttribute(element, kAXRoleDescriptionAttribute as CFString)
        let enabled: Bool = (axCopyAttribute(element, kAXEnabledAttribute as CFString) ?? true)

        let bounds = axElementFrame(element)
        let actionable = isInteractable(role: role, enabled: enabled, hasActions: axHasActions(element))

        // Skip purely structural elements with no useful info.
        let hasAnyText = (title?.isEmpty == false) || (label?.isEmpty == false)
            || (value?.isEmpty == false) || (help?.isEmpty == false)
        let hasNonZeroBounds = bounds.width > 0 && bounds.height > 0
        let interesting = hasAnyText || actionable || ["AXMenuBar", "AXMenu", "AXMenuItem", "AXButton", "AXTextField", "AXTextArea", "AXLink", "AXCheckBox", "AXRadioButton"].contains(role)

        if interesting && hasNonZeroBounds {
            counter += 1
            let id = generateId(role: role, index: counter)
            elements.append([
                "id": id,
                "role": role,
                "title": title as Any? ?? NSNull(),
                "label": label as Any? ?? NSNull(),
                "description": label as Any? ?? NSNull(),
                "role_description": roleDescription as Any? ?? NSNull(),
                "help": help as Any? ?? NSNull(),
                "identifier": identifier as Any? ?? NSNull(),
                "bounds": [
                    "x": bounds.origin.x,
                    "y": bounds.origin.y,
                    "width": bounds.width,
                    "height": bounds.height,
                ],
                "is_actionable": actionable,
                "keyboard_shortcut": NSNull(),
                "value": value as Any? ?? NSNull(),
            ])
        }

        // Recurse into children.
        if let children: [AXUIElement] = axCopyAttribute(element, kAXChildrenAttribute as CFString) {
            for child in children {
                walk(element: child, depth: depth + 1, parentLabel: title ?? label)
                if elements.count >= maxElements { break }
            }
        }
    }

    private func generateId(role: String, index: Int) -> String {
        let prefix: String
        switch role {
        case "AXButton": prefix = "B"
        case "AXTextField", "AXTextArea": prefix = "T"
        case "AXLink": prefix = "L"
        case "AXCheckBox": prefix = "C"
        case "AXRadioButton": prefix = "R"
        case "AXMenuItem": prefix = "M"
        default: prefix = "E"
        }
        return "\(prefix)\(index)"
    }

    private func isInteractable(role: String, enabled: Bool, hasActions: Bool) -> Bool {
        guard enabled else { return false }
        switch role {
        case "AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXMenuItem",
             "AXTextField", "AXTextArea", "AXComboBox", "AXPopUpButton", "AXSlider":
            return true
        default:
            return hasActions
        }
    }
}

// MARK: - AX C API helpers
//
// Conceptual ancestor: Peekaboo (MIT, Copyright 2025 Peter Steinberger)
//   AXDescriptorReader.swift - typed attribute readers
// Modified for 8gent: thin generic wrapper without AXorcist's value classes.

func axCopyAttribute<T>(_ element: AXUIElement, _ attr: CFString) -> T? {
    var value: AnyObject?
    let err = AXUIElementCopyAttributeValue(element, attr, &value)
    guard err == .success else { return nil }
    return value as? T
}

func axCopyValueAsString(_ element: AXUIElement) -> String? {
    if let s: String = axCopyAttribute(element, kAXValueAttribute as CFString) {
        return s
    }
    // Numeric values come back as NSNumber.
    if let n: NSNumber = axCopyAttribute(element, kAXValueAttribute as CFString) {
        return n.stringValue
    }
    return nil
}

func axHasActions(_ element: AXUIElement) -> Bool {
    var actions: CFArray?
    let err = AXUIElementCopyActionNames(element, &actions)
    guard err == .success, let arr = actions as? [String] else { return false }
    return !arr.isEmpty
}

/// Reads the element's bounding box. Position + Size are AXValue types
/// wrapping CGPoint and CGSize; we unwrap with AXValueGetValue.
func axElementFrame(_ element: AXUIElement) -> CGRect {
    var posValue: AnyObject?
    var sizeValue: AnyObject?
    let posErr = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posValue)
    let sizeErr = AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue)
    guard posErr == .success, sizeErr == .success,
          let posObj = posValue, let sizeObj = sizeValue else {
        return .zero
    }
    var position = CGPoint.zero
    var size = CGSize.zero
    let axPos = posObj as! AXValue
    let axSize = sizeObj as! AXValue
    AXValueGetValue(axPos, .cgPoint, &position)
    AXValueGetValue(axSize, .cgSize, &size)
    return CGRect(origin: position, size: size)
}
