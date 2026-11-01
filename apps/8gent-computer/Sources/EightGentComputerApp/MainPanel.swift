import AppKit
import Combine
import SwiftUI

/// Live state surfaced to the SwiftUI panel content.
final class PanelState: ObservableObject {
    /// Caption shown to the user. Live-only, never persisted.
    @Published var caption: String = "Listening..."
    /// Subtle status line under the caption.
    @Published var status: String = "Press Cmd+Opt+Space to dismiss."
    /// User-controlled voice input gate. False means the mic stays off across panel opens.
    @Published var voiceInputEnabled: Bool = true
    /// Connection indicator. True when the daemon socket is up.
    @Published var connected: Bool = false
    /// Approval prompt active. Backed by `pendingApproval` below.
    @Published var pendingApproval: PendingApproval?

    /// Live tool steps - populated as the doer calls tools.
    @Published var toolSteps: [ToolStep] = []

    struct PendingApproval: Identifiable {
        let id = UUID()
        let tool: String
        let requestId: String
        let reason: String?
    }

    struct ToolStep: Identifiable {
        let id: String
        let tool: String
        var status: StepStatus
        var durationMs: Int?

        enum StepStatus: String {
            case running = "running"
            case done = "done"
            case error = "error"
        }
    }

    func pauseVoice() {
        voiceInputEnabled = false
        caption = "Voice paused"
        status = "Press the mic to resume listening."
    }

    func resumeVoice() {
        voiceInputEnabled = true
        caption = "Listening..."
        status = "Listening..."
    }

    func notePanelShown() {
        if voiceInputEnabled {
            caption = "Listening..."
        } else {
            pauseVoice()
        }
    }

    func noteIntentSubmitted(_ text: String) {
        caption = text
        status = "Thinking..."
        toolSteps = []
    }

    func noteToolCall(tool: String, callId: String) {
        let displayName = displayToolName(tool)
        status = "Working: \(displayName)"
        toolSteps.append(.init(id: callId, tool: displayName, status: .running))
    }

    func noteToolResult(tool: String, callId: String, durationMs: Int) {
        let displayName = displayToolName(tool)
        status = "\(displayName) done"
        if let idx = toolSteps.firstIndex(where: { $0.id == callId }) {
            toolSteps[idx].status = .done
            toolSteps[idx].durationMs = durationMs
        } else {
            toolSteps.append(.init(id: callId, tool: displayName, status: .done, durationMs: durationMs))
        }
    }

    func noteDone() {
        status = toolSteps.isEmpty ? "Done. No tool proof received." : "Done. Proof remains visible."
    }

    func noteError(_ error: String) {
        status = "Error: \(error)"
        for i in 0..<toolSteps.count {
            if toolSteps[i].status == .running {
                toolSteps[i].status = .error
            }
        }
    }

    private func displayToolName(_ tool: String) -> String {
        tool.count > 30 ? String(tool.prefix(30)) + "..." : tool
    }
}

/// Glass NSPanel anchored 80px from the bottom, centred horizontally.
/// Wires SpeechCapture, DaemonClient, SpeechReply into one voice loop.
final class MainPanel {
    private let panel: NSPanel
    private var clickOutsideMonitor: Any?
    private var keyDownMonitor: Any?
    private let panelSize = NSSize(width: 560, height: 120)
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

        let host = NSHostingView(rootView: PanelContent(state: state, onToggleVoice: {}, onApprove: { _, _ in }))
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

        host.rootView = PanelContent(
            state: state,
            onToggleVoice: { [weak self] in self?.toggleVoiceInput() },
            onApprove: { [weak self] reqId, ok in
                self?.client.sendApproval(requestId: reqId, approved: ok)
                self?.state.pendingApproval = nil
            }
        )

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
        if state.voiceInputEnabled {
            startListening()
        } else {
            state.notePanelShown()
        }
    }

    func hide() {
        removeDismissMonitors()
        capture.stop()
        panel.orderOut(nil)
    }

    private func toggleVoiceInput() {
        if state.voiceInputEnabled {
            capture.stop()
            reply.stop()
            state.pauseVoice()
            return
        }

        state.resumeVoice()
        startListening()
    }

    private func startListening() {
        guard state.voiceInputEnabled else {
            capture.stop()
            state.notePanelShown()
            return
        }

        if !hasRequestedAuth {
            hasRequestedAuth = true
            capture.requestAuthorization { [weak self] status in
                guard let self = self else { return }
                if status == .granted && self.state.voiceInputEnabled {
                    self.state.caption = "Listening..."
                    self.capture.start()
                } else if status == .granted {
                    self.state.pauseVoice()
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
            guard self?.state.voiceInputEnabled == true else { return }
            self?.state.caption = text
        }
        capture.onFinal = { [weak self] text in
            guard let self = self else { return }
            guard self.state.voiceInputEnabled else { return }
            self.capture.stop()
            self.tokenTail = ""
            self.state.noteIntentSubmitted(text)
            self.client.sendIntent(text)
            self.revealForAgentActivity()
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
            case let .toolCall(_, tool, callId, _):
                self.state.noteToolCall(tool: tool, callId: callId)
                self.revealForAgentActivity()
            case let .toolResult(_, tool, callId, _, durationMs):
                self.state.noteToolResult(tool: tool, callId: callId, durationMs: durationMs)
                self.revealForAgentActivity()
            case let .approvalRequired(_, tool, requestId, reason):
                self.state.pendingApproval = .init(tool: tool, requestId: requestId, reason: reason)
                self.revealForAgentActivity()
            case let .error(_, error, _):
                self.state.noteError(error)
                self.revealForAgentActivity()
            case .done:
                self.reply.flush()
                self.state.noteDone()
                self.revealForAgentActivity()
            }
        }
    }

    private func revealForAgentActivity() {
        positionAtBottomCentre()
        panel.orderFrontRegardless()
        installDismissMonitors()
    }

    private func positionAtBottomCentre() {
        guard let screen = NSScreen.main else { return }
        let frame = screen.visibleFrame
        let x = frame.midX - panelSize.width / 2
        let y = frame.minY + bottomInset
        panel.setFrame(NSRect(x: x, y: y, width: panelSize.width, height: panelSize.height), display: true)
    }

    private func installDismissMonitors() {
        removeDismissMonitors()

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
    let onToggleVoice: () -> Void
    let onApprove: (String, Bool) -> Void

    var body: some View {
        ZStack(alignment: .top) {
            HStack(spacing: 16) {
                Button(action: onToggleVoice) {
                    Image(systemName: state.voiceInputEnabled ? "mic.fill" : "mic.slash.fill")
                        .font(.system(size: 18, weight: .semibold))
                        .frame(width: 44, height: 44)
                        .background(buttonFill)
                        .foregroundStyle(.primary.opacity(0.9))
                        .clipShape(Circle())
                        .shadow(color: .black.opacity(0.22), radius: 8, x: 0, y: 3)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(state.voiceInputEnabled ? "Pause voice input" : "Resume voice input")

                AudioWaveView()
                    .frame(width: 96, height: 48)
                    .opacity(state.voiceInputEnabled ? 1.0 : 0.32)

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

                    // Live tool steps - compact pill badges
                    if !state.toolSteps.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(state.toolSteps) { step in
                                    ToolStepBadge(step: step)
                                }
                            }
                        }
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

    private var buttonFill: Color {
        state.voiceInputEnabled ? Color.white.opacity(0.18) : Color.orange.opacity(0.22)
    }
}

private struct ToolStepBadge: View {
    let step: PanelState.ToolStep

    var body: some View {
        HStack(spacing: 4) {
            statusIcon
            Text(step.tool)
                .font(.system(.caption2, design: .default).monospaced())
                .lineLimit(1)
            if let ms = step.durationMs {
                Text("\(ms)ms")
                    .font(.system(.caption2, design: .default))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(badgeColor.opacity(0.2))
        .foregroundStyle(badgeColor)
        .cornerRadius(10)
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch step.status {
        case .running:
            ProgressView()
                .scaleEffect(0.5)
                .frame(width: 10, height: 10)
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 10))
        case .error:
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 10))
        }
    }

    private var badgeColor: Color {
        switch step.status {
        case .running: return .blue
        case .done: return .green
        case .error: return .red
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
