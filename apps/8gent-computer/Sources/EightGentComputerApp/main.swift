import AppKit
import Foundation

let args = CommandLine.arguments

if args.contains("--headless") {
    var intent = ""
    if let idx = args.firstIndex(of: "--intent"), idx + 1 < args.count {
        intent = args[idx + 1]
    }
    let payload: [String: Any] = [
        "status": "noop",
        "headless_phase": "scaffold",
        "intent": intent
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    }
    exit(0)
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
