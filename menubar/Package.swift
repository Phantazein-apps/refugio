// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "RefugioBar",
    platforms: [
        .macOS(.v13)   // SMAppService (launch-at-login) needs macOS 13+
    ],
    targets: [
        .executableTarget(
            name: "RefugioBar",
            path: "Sources/RefugioBar",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("SwiftUI"),
                .linkedFramework("WebKit"),
                .linkedFramework("ServiceManagement")
            ]
        )
    ]
)
