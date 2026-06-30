import AppKit
import ServiceManagement

/// Launch-at-login via the modern ServiceManagement API (macOS 13+). Registers this app
/// bundle so macOS relaunches REFUGIO's menu-bar app after login. The first enable may
/// surface as "requires approval", in which case we open System Settings ▸ Login Items.
enum LoginItem {
    static var isEnabled: Bool {
        if #available(macOS 13.0, *) { return SMAppService.mainApp.status == .enabled }
        return false
    }

    static func setEnabled(_ on: Bool) {
        guard #available(macOS 13.0, *) else { return }
        let svc = SMAppService.mainApp
        do {
            if on {
                if svc.status != .enabled { try svc.register() }
                if svc.status == .requiresApproval {
                    SMAppService.openSystemSettingsLoginItems()
                }
            } else if svc.status == .enabled {
                try svc.unregister()
            }
        } catch {
            NSLog("REFUGIO login item \(on ? "register" : "unregister") failed: \(error.localizedDescription)")
        }
    }
}
