import AppKit

/// Cmd+Opt+Space global hotkey.
/// Uses NSEvent monitors (read-only, no Accessibility prompt at launch).
final class HotkeyMonitor {
    private let onTrigger: () -> Void
    private var globalMonitor: Any?
    private var localMonitor: Any?

    init(onTrigger: @escaping () -> Void) {
        self.onTrigger = onTrigger
    }

    func start() {
        let mask: NSEvent.EventTypeMask = [.keyDown]

        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
            self?.handle(event)
        }

        localMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            if self?.matches(event) == true {
                self?.onTrigger()
                return nil
            }
            return event
        }
    }

    func stop() {
        if let g = globalMonitor { NSEvent.removeMonitor(g) }
        if let l = localMonitor { NSEvent.removeMonitor(l) }
        globalMonitor = nil
        localMonitor = nil
    }

    deinit {
        stop()
    }

    private func handle(_ event: NSEvent) {
        if matches(event) {
            DispatchQueue.main.async { [weak self] in
                self?.onTrigger()
            }
        }
    }

    private func matches(_ event: NSEvent) -> Bool {
        // keyCode 49 = Space on US layout
        guard event.keyCode == 49 else { return false }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let required: NSEvent.ModifierFlags = [.command, .option]
        return flags == required
    }
}
