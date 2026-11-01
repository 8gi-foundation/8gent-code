// swift-tools-version: 6.0
// 8gent AX bridge - bundled native helper for the @8gent/eyes ax-native backend.
// Zero external Swift package dependencies. Stdin/stdout JSON-line IPC.
//
// Pattern follows bin/apple-foundation-bridge: a single thin Swift executable
// that exposes one capability over a JSON envelope so the TS adapter has a
// stable, tool-level contract.
//
// Conceptual ancestor: Peekaboo (https://github.com/steipete/peekaboo) MIT,
// Copyright 2025 Peter Steinberger. See ../NOTICE.

import PackageDescription

let package = Package(
    name: "eight-ax-bridge",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "EightAxBridge",
            path: "Sources/EightAxBridge"
        )
    ]
)
