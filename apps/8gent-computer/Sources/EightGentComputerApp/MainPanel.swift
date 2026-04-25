import AppKit
import Combine
import SwiftUI

/// Live state surfaced to the SwiftUI panel content.
final class PanelState: ObservableObject {
    /// Caption shown to the user. Live-only, never persisted.
    @Published var caption: String = "Listening..."
    /// Subtle status line under the caption.
    @Published var status: String = "Press Cmd+Opt+Space to dismiss."
    /// Connection indicator. True when the daemon socket is up.
    @Published var connected: Bool = false
    /// Approval prompt active. Backed by `pendingApproval` below.
    @Published var pendingApproval: PendingApproval?

    struct PendingApproval: Identifiable {
        let id = UUID()
        let tool: String
        let requestId: String
        let reason: String?
    }
}

/// Glass NSPanel anchored 80px from the bottom, centred horizontally.
/// Wires SpeechCapture, DaemonClient, SpeechReply into one voice loop.
final class MainPanel {
    private let panel: NSPanel
    private var clickOutsideMonitor: Any?
    private var keyDownMonitor: Any?
    private let panelSize = NSSize(width: 560, height: 96)
    private let bottomInset: CGFloat = 80

    private let state = PanelState()
    private let capture = SpeechCapture()
    private let client = DaemonClient()
    private let reply = SpeechReply()
    private var hasRequestedAuth: Bool = false
    private var tokenTail: String = ""

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

        let host = NSHostingView(rootView: PanelContent(state: state, onApprove: { _, _ in }))
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

        wireClient()
        wireCapture()

        host.rootView = PanelContent(state: state, onApprove: { [weak self] reqId, ok in
            self?.client.sendApproval(requestId: reqId, approved: ok)
            self?.state.pendingApproval = nil
        })

        client.connect()
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
        // Next hotkey press while already speaking interrupts TTS.
        reply.stop()
        positionAtBottomCentre()
        panel.orderFrontRegardless()
        installDismissMonitors()
        startListening()
    }

    func hide() {
        removeDismissMonitors()
        capture.stop()
        panel.orderOut(nil)
    }

    private func startListening() {
        if !hasRequestedAuth {
            hasRequestedAuth = true
            capture.requestAuthorization { [weak self] status in
                guard let self = self else { return }
                if status == .granted {
                    self.state.caption = "Listening..."
                    self.capture.start()
                } else {
                    self.state.caption = "Microphone access is required."
                    self.state.status = "Open System Settings, Privacy, and grant access to 8gent Computer."
                }
            }
        } else {
            state.caption = "Listening..."
            capture.start()
        }
    }

    private func wireCapture() {
        capture.onPartial = { [weak self] text in
            self?.state.caption = text
        }
        capture.onFinal = { [weak self] text in
            guard let self = self else { return }
            self.state.caption = text
            self.capture.stop()
            self.tokenTail = ""
            self.client.sendIntent(text)
            self.state.status = "Thinking..."
        }
        capture.onError = { [weak self] err in
            self?.state.status = "Capture error: \(err)"
        }
    }

    private func wireClient() {
        client.onState = { [weak self] s in
            self?.state.connected = (s == .connected)
            switch s {
            case .connected: self?.state.status = "Connected."
            case .connecting: self?.state.status = "Connecting..."
            case .disconnected: self?.state.status = "Reconnecting..."
            }
        }
        client.onProtocolError = { [weak self] msg in
            self?.state.status = "Daemon: \(msg)"
        }
        client.onEvent = { [weak self] ev in
            guard let self = self else { return }
            switch ev {
            case let .token(_, chunk, final):
                self.tokenTail.append(chunk)
                self.state.caption = self.tokenTail
                self.reply.append(chunk)
                if final {
                    self.state.status = "Done."
                }
            case .toolCall:
                self.state.status = "(acting)"
            case .toolResult:
                self.state.status = "(thinking)"
            case let .approvalRequired(_, tool, requestId, reason):
                self.state.pendingApproval = .init(tool: tool, requestId: requestId, reason: reason)
            case let .error(_, error, _):
                self.state.status = "Error: \(error)"
            case .done:
                self.reply.flush()
                self.state.status = "Press Cmd+Opt+Space to dismiss."
            }
        }
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
    @ObservedObject var state: PanelState
    let onApprove: (String, Bool) -> Void

    var body: some View {
        ZStack(alignment: .top) {
            HStack(spacing: 16) {
                AudioWaveView()
                    .frame(width: 96, height: 48)

                VStack(alignment: .leading, spacing: 4) {
                    Text(state.caption)
                        .font(.system(.title3, design: .default).weight(.medium))
                        .foregroundStyle(.primary.opacity(0.92))
                        .lineLimit(2)
                    HStack(spacing: 8) {
                        Circle()
                            .fill(state.connected ? Color.green.opacity(0.8) : Color.orange.opacity(0.85))
                            .frame(width: 6, height: 6)
                        Text(state.status)
                            .font(.system(.callout, design: .default))
                            .foregroundStyle(.secondary.opacity(0.85))
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 18)

            if let approval = state.pendingApproval {
                ApprovalSheet(
                    tool: approval.tool,
                    reason: approval.reason,
                    onApprove: { onApprove(approval.requestId, true) },
                    onDeny: { onApprove(approval.requestId, false) }
                )
                .transition(.opacity)
            }
        }
    }
}

private struct ApprovalSheet: View {
    let tool: String
    let reason: String?
    let onApprove: () -> Void
    let onDeny: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Approve action: \(tool)")
                .font(.system(.headline))
            if let reason = reason {
                Text(reason)
                    .font(.system(.callout))
                    .foregroundStyle(.secondary)
            }
            HStack {
                Button("Deny", action: onDeny)
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Approve", action: onApprove)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .background(.ultraThinMaterial)
        .cornerRadius(12)
        .padding(8)
    }
}
