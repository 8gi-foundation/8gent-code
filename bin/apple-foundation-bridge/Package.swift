// swift-tools-version: 6.0
// Apple Foundation Model bridge for 8gent-code.
// Zero external dependencies. Stdin/stdout JSON-line IPC.
//
// Deployment target is macOS 15 (Sequoia) for PackageDescription compatibility;
// the FoundationModels import is gated with `#if canImport(FoundationModels)`
// and only resolves on macOS 26 Tahoe SDKs, so older hosts silently no-op.

import PackageDescription

let package = Package(
    name: "apple-foundation-bridge",
    platforms: [
        .macOS(.v15)
    ],
    targets: [
        .executableTarget(
            name: "AppleFoundationBridge",
            path: "Sources/AppleFoundationBridge"
        )
    ]
)
