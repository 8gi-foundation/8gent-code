import AppKit
import Foundation

let args = CommandLine.arguments

if args.contains("--headless") {
    var intent = ""
    if let idx = args.firstIndex(of: "--intent"), idx + 1 < args.count {
        intent = args[idx + 1]
    }
    if intent.isEmpty {
        FileHandle.standardError.write(Data("--headless requires --intent \"...\"\n".utf8))
        exit(1)
    }
    let code = HeadlessMode.run(intent: intent)
    exit(code)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var hotkey: HotkeyMonitor?
    private var panel: MainPanel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let panel = MainPanel()
        self.panel = panel

        let monitor = HotkeyMonitor { [weak panel] in
            panel?.toggle()
        }
        monitor.start()
        self.hotkey = monitor
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
