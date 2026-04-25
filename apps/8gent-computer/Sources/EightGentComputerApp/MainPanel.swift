import AppKit
import SwiftUI

/// Glass NSPanel anchored 80px from the bottom, centred horizontally.
/// Excluded from the Dock and window switcher. Auto-dismiss on Esc and click-outside.
final class MainPanel {
    private let panel: NSPanel
    private var clickOutsideMonitor: Any?
    private var keyDownMonitor: Any?
    private let panelSize = NSSize(width: 560, height: 96)
    private let bottomInset: CGFloat = 80

    init() {
        let style: NSWindow.StyleMask = [.borderless, .nonactivatingPanel]
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: panelSize),
            styleMask: style,
            backing: .buffered,
            defer: false
        )

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = false
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true

        let host = NSHostingView(rootView: PanelContent())
        host.frame = NSRect(origin: .zero, size: panelSize)
        host.autoresizingMask = [.width, .height]

        let visualEffect = NSVisualEffectView(frame: NSRect(origin: .zero, size: panelSize))
        visualEffect.material = .hudWindow
        visualEffect.blendingMode = .behindWindow
        visualEffect.state = .active
        visualEffect.wantsLayer = true
        visualEffect.layer?.cornerRadius = 18
        visualEffect.layer?.masksToBounds = true
        visualEffect.autoresizingMask = [.width, .height]
        visualEffect.addSubview(host)

        panel.contentView = visualEffect
        self.panel = panel
    }

    var isVisible: Bool { panel.isVisible }

    func toggle() {
        if isVisible {
            hide()
        } else {
            show()
        }
    }

    func show() {
        positionAtBottomCentre()
        panel.orderFrontRegardless()
        installDismissMonitors()
    }

    func hide() {
        removeDismissMonitors()
        panel.orderOut(nil)
    }

    private func positionAtBottomCentre() {
        guard let screen = NSScreen.main else { return }
        let frame = screen.visibleFrame
        let x = frame.midX - panelSize.width / 2
        let y = frame.minY + bottomInset
        panel.setFrame(NSRect(x: x, y: y, width: panelSize.width, height: panelSize.height), display: true)
    }

    private func installDismissMonitors() {
        keyDownMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            // keyCode 53 = Escape
            if event.keyCode == 53 {
                self?.hide()
                return nil
            }
            return event
        }

        clickOutsideMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.hide()
        }
    }

    private func removeDismissMonitors() {
        if let m = keyDownMonitor { NSEvent.removeMonitor(m) }
        if let m = clickOutsideMonitor { NSEvent.removeMonitor(m) }
        keyDownMonitor = nil
        clickOutsideMonitor = nil
    }
}

private struct PanelContent: View {
    var body: some View {
        HStack(spacing: 16) {
            AudioWaveView()
                .frame(width: 96, height: 48)

            VStack(alignment: .leading, spacing: 4) {
                Text("Listening")
                    .font(.system(.title3, design: .default).weight(.medium))
                    .foregroundStyle(.primary.opacity(0.92))
                Text("Press Cmd+Opt+Space to dismiss.")
                    .font(.system(.callout, design: .default))
                    .foregroundStyle(.secondary.opacity(0.85))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
    }
}
