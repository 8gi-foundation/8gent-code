// 8gentComputerApp.swift - app entry, menubar item, floating window.
//
// v0:
//   - NSStatusBar item with the title "8" (no SF Symbols, deliberately plain)
//   - Clicking the item toggles a floating window hosting MainWindow
//   - LSUIElement = true (in Info.plist) so we don't show in the Dock
//   - SwiftUI default theme (system light/dark)
//
// We use AppKit + NSApplicationDelegateAdaptor instead of pure SwiftUI App
// scenes because the menubar pattern is much cleaner this way.

import SwiftUI
import AppKit

@main
struct EightComputerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Settings { EmptyView() }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Standard Edit menu so Cmd+C / V / A work in the text field.
        let mainMenu = NSMenu()
        let editMenuItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)
        NSApplication.shared.mainMenu = mainMenu

        // Menubar item.
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.title = "8"
            button.font = NSFont.boldSystemFont(ofSize: 14)
            button.toolTip = "8gent Computer"
            button.setAccessibilityLabel("8gent Computer menubar item")
            button.setAccessibilityRole(.button)
            button.action = #selector(toggleWindow(_:))
            button.target = self
        }
        self.statusItem = item

        NSApp.setActivationPolicy(.accessory)
    }

    @objc private func toggleWindow(_ sender: Any?) {
        if let win = window, win.isVisible {
            win.orderOut(nil)
            return
        }
        showWindow()
    }

    private func showWindow() {
        if window == nil {
            let view = MainWindow()
            let hosting = NSHostingController(rootView: view)
            let win = NSWindow(contentViewController: hosting)
            win.title = "8gent Computer"
            win.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
            win.titlebarAppearsTransparent = false
            win.isReleasedWhenClosed = false
            win.level = .floating
            win.setContentSize(NSSize(width: 560, height: 480))
            win.center()
            win.setAccessibilityLabel("8gent Computer main window")
            self.window = win
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
