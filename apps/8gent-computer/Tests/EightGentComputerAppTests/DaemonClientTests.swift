import XCTest
@testable import EightGentComputerApp

final class DaemonClientTests: XCTestCase {
    func testConfiguredURLUsesEnvironmentOverrideWhenPresent() {
        let url = DaemonClient.configuredURL(environment: [
            "EIGHT_DAEMON_URL": "ws://127.0.0.1:18791/computer"
        ])

        XCTAssertEqual(url.absoluteString, "ws://127.0.0.1:18791/computer")
    }

    func testConfiguredURLFallsBackToDefaultForInvalidOverride() {
        let url = DaemonClient.configuredURL(environment: [
            "EIGHT_DAEMON_URL": "not a websocket url"
        ])

        XCTAssertEqual(url, DaemonClient.defaultURL)
    }
}
