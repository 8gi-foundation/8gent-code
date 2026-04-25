// MainWindow.swift - floating SwiftUI window: prompt input, Run button, output.
//
// v0 scope:
//   - one text field
//   - one Run button (Enter triggers it too)
//   - readonly output area showing the parsed RunResult, plus screenshot preview
//   - no consent UI, no policy gating, no streaming - runs immediately on submit
//
// Accessibility: every interactive control has an accessibilityLabel and hint.
// Window respects system theme by default.

import SwiftUI
import AppKit

@MainActor
final class RunState: ObservableObject {
    @Published var prompt: String = ""
    @Published var isRunning: Bool = false
    @Published var lastResult: RunResult?
    @Published var lastImage: NSImage?
    @Published var lastImagePath: String?
    @Published var lastError: String?
    @Published var lastStderr: String?

    func submit() {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isRunning else { return }
        isRunning = true
        lastError = nil
        lastStderr = nil
        lastResult = nil
        lastImage = nil
        lastImagePath = nil

        Task {
            do {
                let (result, stderr) = try await HandsBridge.run(prompt: trimmed)
                self.lastResult = result
                self.lastStderr = stderr
                if let path = result.results.compactMap(\.imagePath).first {
                    self.lastImagePath = path
                    self.lastImage = NSImage(contentsOfFile: path)
                }
            } catch {
                self.lastError = error.localizedDescription
            }
            self.isRunning = false
        }
    }
}

struct MainWindow: View {
    @StateObject private var state = RunState()
    @FocusState private var promptFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            HStack(spacing: 8) {
                TextField("What should the computer do?", text: $state.prompt)
                    .textFieldStyle(.roundedBorder)
                    .focused($promptFocused)
                    .onSubmit { state.submit() }
                    .accessibilityLabel("Prompt for 8gent Computer")
                    .accessibilityHint("Type a natural-language instruction, then press Run.")
                    .disabled(state.isRunning)

                Button(action: { state.submit() }) {
                    if state.isRunning {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityLabel("Running")
                    } else {
                        Text("Run")
                            .frame(minWidth: 44)
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(state.isRunning || state.prompt.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityLabel("Run prompt")
                .accessibilityHint("Send the prompt to 8gent Computer and execute the planned actions.")
            }

            Divider()

            outputArea
        }
        .padding(16)
        .frame(minWidth: 520, minHeight: 420)
        .onAppear { promptFocused = true }
    }

    private var header: some View {
        HStack {
            Text("8gent Computer")
                .font(.system(size: 16, weight: .semibold))
                .accessibilityAddTraits(.isHeader)
            Spacer()
            Text("v0")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
                .accessibilityLabel("Version v0")
        }
    }

    @ViewBuilder
    private var outputArea: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let err = state.lastError {
                    sectionHeader("Error")
                    Text(err)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                        .accessibilityLabel("Error message")
                }

                if let result = state.lastResult {
                    sectionHeader("Plan (\(result.plannerMode))")
                    if result.plan.isEmpty {
                        Text("No steps. The planner could not interpret your prompt.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(result.plan.enumerated()), id: \.offset) { idx, step in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(idx + 1). \(step.tool)")
                                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                                if let r = step.rationale, !r.isEmpty {
                                    Text(r)
                                        .font(.system(size: 11))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }

                    sectionHeader("Result")
                    ForEach(Array(result.results.enumerated()), id: \.offset) { idx, sr in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(idx + 1). \(sr.step.tool) - \(sr.ok ? "ok" : "failed") (\(sr.durationMs)ms)")
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                                .foregroundStyle(sr.ok ? Color.primary : Color.red)
                            if let path = sr.imagePath {
                                Text("Screenshot: \(path)")
                                    .font(.system(size: 11, design: .monospaced))
                                    .textSelection(.enabled)
                                    .accessibilityLabel("Screenshot file path")
                            }
                            if let out = sr.output, !out.isEmpty {
                                Text(out)
                                    .font(.system(size: 11, design: .monospaced))
                                    .textSelection(.enabled)
                                    .lineLimit(20)
                            }
                            if let err = sr.error, !err.isEmpty {
                                Text(err)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.red)
                                    .textSelection(.enabled)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }

                if let img = state.lastImage {
                    sectionHeader("Screenshot preview")
                    Image(nsImage: img)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 240)
                        .accessibilityLabel("Captured screenshot preview")
                }

                if state.lastResult == nil && state.lastError == nil && !state.isRunning {
                    Text("Try: \"take a screenshot\" or \"list running apps\".")
                        .foregroundStyle(.secondary)
                        .font(.system(size: 12))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.secondary)
            .accessibilityAddTraits(.isHeader)
    }
}
