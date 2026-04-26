// Accessibility tree CLI helper.
//
// Reads a target PID (or auto-resolves the focused window) and walks the
// AppKit accessibility tree using AXUIElementCopyAttributeValue. Emits a
// structured JSON tree on stdout that the TypeScript daemon shim consumes
// via execFile. No daemon coupling, no GUI; pure macOS CLI.
//
// Usage:
//   accessibility-tree-cli                 # focused window
//   accessibility-tree-cli --pid 1234      # specific PID
//   accessibility-tree-cli --json-only     # suppress diagnostics on stderr

import Foundation
import ApplicationServices
import AppKit

// MARK: - Argument parsing

struct AXCLIArgs {
    var pid: pid_t? = nil
    var jsonOnly: Bool = false
}

func parseArgs() -> AXCLIArgs {
    var args = AXCLIArgs()
    var i = 1
    let argv = CommandLine.arguments
    while i < argv.count {
        let arg = argv[i]
        switch arg {
        case "--pid":
            i += 1
            if i < argv.count, let p = pid_t(argv[i]) { args.pid = p }
        case "--json-only":
            args.jsonOnly = true
        default:
            FileHandle.standardError.write(Data("[ax-cli] ignoring arg: \(arg)\n".utf8))
        }
        i += 1
    }
    return args
}

// MARK: - AX walking

struct AxNode: Encodable {
    let role: String
    let title: String?
    let value: String?
    let position: Position?
    let size: Size?
    let enabled: Bool?
    let focused: Bool?
    let clickable: Bool?
    let children: [AxNode]?

    struct Position: Encodable { let x: Double; let y: Double }
    struct Size: Encodable { let width: Double; let height: Double }
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    if result != .success { return nil }
    return value as? String
}

func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    if result != .success { return nil }
    if let n = value as? NSNumber { return n.boolValue }
    return nil
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
    if result != .success { return [] }
    return (value as? [AXUIElement]) ?? []
}

func axPosition(_ element: AXUIElement) -> AxNode.Position? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &value)
    if result != .success { return nil }
    var point = CGPoint.zero
    let axValue = value as! AXValue
    if AXValueGetValue(axValue, .cgPoint, &point) {
        return AxNode.Position(x: Double(point.x), y: Double(point.y))
    }
    return nil
}

func axSize(_ element: AXUIElement) -> AxNode.Size? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &value)
    if result != .success { return nil }
    var size = CGSize.zero
    let axValue = value as! AXValue
    if AXValueGetValue(axValue, .cgSize, &size) {
        return AxNode.Size(width: Double(size.width), height: Double(size.height))
    }
    return nil
}

let CLICKABLE_ROLES: Set<String> = [
    "AXButton", "AXLink", "AXMenuItem", "AXMenuButton", "AXCheckBox",
    "AXRadioButton", "AXTab", "AXPopUpButton",
]

func walkAX(_ element: AXUIElement, depth: Int, maxDepth: Int) -> AxNode {
    let role = axString(element, kAXRoleAttribute) ?? "AXUnknown"
    let title = axString(element, kAXTitleAttribute) ?? axString(element, kAXDescriptionAttribute)
    let value = axString(element, kAXValueAttribute)
    let position = axPosition(element)
    let size = axSize(element)
    let enabled = axBool(element, kAXEnabledAttribute)
    let focused = axBool(element, kAXFocusedAttribute)
    let clickable = CLICKABLE_ROLES.contains(role)

    var childrenOut: [AxNode]? = nil
    if depth < maxDepth {
        let kids = axChildren(element)
        if !kids.isEmpty {
            childrenOut = kids.map { walkAX($0, depth: depth + 1, maxDepth: maxDepth) }
        }
    }

    return AxNode(
        role: role,
        title: title,
        value: value,
        position: position,
        size: size,
        enabled: enabled,
        focused: focused,
        clickable: clickable,
        children: childrenOut
    )
}

// MARK: - Top-level resolver

struct TreeOutput: Encodable {
    let ok: Bool
    let pid: pid_t?
    let appName: String?
    let windowTitle: String?
    let root: AxNode?
    let error: String?
}

func emit(_ output: TreeOutput) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    do {
        let data = try encoder.encode(output)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        FileHandle.standardError.write(Data("[ax-cli] encode error: \(error)\n".utf8))
        exit(2)
    }
}

func resolveTargetPID(_ args: AXCLIArgs) -> (pid_t, String)? {
    if let pid = args.pid {
        let app = NSRunningApplication(processIdentifier: pid)
        return (pid, app?.localizedName ?? "(unknown)")
    }
    guard let frontmost = NSWorkspace.shared.frontmostApplication else { return nil }
    return (frontmost.processIdentifier, frontmost.localizedName ?? "(focused)")
}

func main() {
    let args = parseArgs()

    if !AXIsProcessTrusted() {
        emit(TreeOutput(
            ok: false, pid: nil, appName: nil, windowTitle: nil, root: nil,
            error: "Accessibility permission not granted. Open System Settings -> Privacy & Security -> Accessibility and enable the calling binary."
        ))
        exit(1)
    }

    guard let (pid, appName) = resolveTargetPID(args) else {
        emit(TreeOutput(
            ok: false, pid: nil, appName: nil, windowTitle: nil, root: nil,
            error: "No target window: pass --pid or focus an app."
        ))
        exit(1)
    }

    let appElement = AXUIElementCreateApplication(pid)

    var focusedWindow: AnyObject?
    let focusedResult = AXUIElementCopyAttributeValue(
        appElement, kAXFocusedWindowAttribute as CFString, &focusedWindow)

    let target: AXUIElement
    var windowTitle: String? = nil
    if focusedResult == .success, let win = focusedWindow {
        target = win as! AXUIElement
        windowTitle = axString(target, kAXTitleAttribute)
    } else {
        target = appElement
    }

    let root = walkAX(target, depth: 0, maxDepth: 6)
    emit(TreeOutput(
        ok: true, pid: pid, appName: appName, windowTitle: windowTitle, root: root, error: nil
    ))
}

main()
