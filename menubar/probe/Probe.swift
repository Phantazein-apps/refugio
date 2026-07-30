// A deliberately minimal menu-bar app, structured exactly like SmackMyMacUp —
// which works on the machine where REFUGIO's icon does not.
//
// It shows the word PROBE. Not an icon, not a template image, not an SF Symbol:
// a string, which cannot fail to draw. It has no menu, no timers, no placement
// checks, no Dock fallback, no supervisor. If PROBE appears in the menu bar,
// the machine is fine and the difference is somewhere in REFUGIO. If it does
// not, nothing REFUGIO does to itself can help and the problem is the machine.
import AppKit
import SwiftUI

@MainActor
final class ProbeDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "PROBE"

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Quit PROBE", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu

        // One line, so there is something to read if nothing appears.
        let f = statusItem.button?.window?.frame ?? .zero
        let onScreen = statusItem.button?.window?.screen != nil
        let line = "PROBE: button=\(statusItem.button != nil) frame=\(f) screen=\(onScreen)\n"
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".refugio-logs/probe.log")
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? line.data(using: .utf8)?.write(to: url)
        print(line)
    }
}

@main
struct ProbeApp: App {
    @NSApplicationDelegateAdaptor(ProbeDelegate.self) var delegate
    var body: some Scene { Settings { EmptyView() } }
}
