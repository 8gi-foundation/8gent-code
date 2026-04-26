// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "8gent-computer",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "8gent-computer",
            targets: ["EightGentComputerApp"]
        ),
        .executable(
            name: "accessibility-tree-cli",
            targets: ["AccessibilityTreeCLI"]
        )
    ],
    targets: [
        .executableTarget(
            name: "EightGentComputerApp",
            path: "Sources/EightGentComputerApp"
        ),
        .executableTarget(
            name: "AccessibilityTreeCLI",
            path: "Sources/AccessibilityTreeCLI"
        )
    ]
)
