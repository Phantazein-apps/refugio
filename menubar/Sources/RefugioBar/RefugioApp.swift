import AppKit
import SwiftUI

/// Entry point.
///
/// This was a hand-written `main.swift` — `NSApplication.shared`, set the
/// activation policy, `app.run()` — which is the textbook way to write an
/// AppKit agent and never got a menu bar icon on macOS 26. The two menu-bar
/// apps that DO work on the same machine (SmackMyMacUp, ItsGOATtime) are both
/// SwiftUI `App`s declaring a Scene, and the failing machine's own log showed
/// Control Center hosting status items through FrontBoard *scenes*
/// (`NSSceneFenceAction`). An app that declares no scene is a poor candidate
/// for a scene-hosted status item.
///
/// So this now matches them exactly: a SwiftUI `App` with an empty `Settings`
/// scene — which draws nothing and costs nothing — and the delegate attached
/// through `@NSApplicationDelegateAdaptor`.
@main
struct RefugioApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // Menu-bar only. The scene exists so the app has one, not to be shown.
        Settings { EmptyView() }
    }
}
