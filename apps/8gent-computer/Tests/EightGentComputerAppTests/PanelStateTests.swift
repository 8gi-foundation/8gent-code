import XCTest
@testable import EightGentComputerApp

final class PanelStateTests: XCTestCase {
    func testMicPauseKeepsVoiceOffUntilExplicitResume() {
        let state = PanelState()

        state.pauseVoice()

        XCTAssertFalse(state.voiceInputEnabled)
        XCTAssertEqual(state.caption, "Voice paused")
        XCTAssertEqual(state.status, "Press the mic to resume listening.")

        state.notePanelShown()

        XCTAssertFalse(state.voiceInputEnabled)
        XCTAssertEqual(state.caption, "Voice paused")

        state.resumeVoice()

        XCTAssertTrue(state.voiceInputEnabled)
        XCTAssertEqual(state.caption, "Listening...")
    }

    func testDonePreservesToolProofForPostTurnInspection() {
        let state = PanelState()

        state.noteToolCall(tool: "desktop_screenshot", callId: "call-1")
        state.noteToolResult(tool: "desktop_screenshot", callId: "call-1", durationMs: 123)
        state.noteDone()

        XCTAssertEqual(state.status, "Done. Proof remains visible.")
        XCTAssertEqual(state.toolSteps.count, 1)
        XCTAssertEqual(state.toolSteps.first?.tool, "desktop_screenshot")
        XCTAssertEqual(state.toolSteps.first?.status, .done)
        XCTAssertEqual(state.toolSteps.first?.durationMs, 123)
    }
}
