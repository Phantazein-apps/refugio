import AppKit

// Entry point. Strong global so the delegate lives for the app's lifetime
// (NSApplication.delegate is a weak reference).
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // menu-bar agent, no Dock icon (matches LSUIElement)
app.run()
