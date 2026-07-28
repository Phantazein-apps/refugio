# REFUGIO tray icon for Windows.
#
# Mirrors the macOS menu-bar app: start / stop / open, live status, live RAM,
# and — the one that matters — a Quit that actually stops the stack and frees
# the memory, distinct from closing the tray icon.
#
# Uses WinForms NotifyIcon, which ships with Windows. No dependency, no build
# step, no toolchain — the same constraint that governs the rest of REFUGIO.
#
# Launched by the installer; run manually with:
#   powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File refugio-tray.ps1

param(
    [string]$RefugioDir = "$env:USERPROFILE\refugio"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "SilentlyContinue"

$ChatPort = if ($env:REFUGIO_CHAT_PORT) { $env:REFUGIO_CHAT_PORT } else { "8090" }
$OwuiPort = "8080"
$StartScript = Join-Path $RefugioDir "start-refugio.cjs"

# ── Helpers ──────────────────────────────────────────────────

function Test-Port([string]$Port) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $iar = $c.BeginConnect("127.0.0.1", [int]$Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(400, $false)
        if ($ok) { $c.EndConnect($iar) }
        $c.Close()
        return $ok
    } catch { return $false }
}

function Get-RefugioUrl {
    if (Test-Port $ChatPort) { return "http://127.0.0.1:$ChatPort" }
    if (Test-Port $OwuiPort) { return "http://127.0.0.1:$OwuiPort" }
    return $null
}

# Resident memory of the whole stack, in MB. Node covers the supervisor and the
# chat server; ollama and python cover the model and Open WebUI.
function Get-StackMemoryMB {
    try {
        $names = @("node", "ollama", "ollama app", "python", "pythonw", "mcpo")
        $sum = 0
        foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
            if ($names -contains $p.ProcessName.ToLower()) { $sum += $p.WorkingSet64 }
        }
        return [int]($sum / 1MB)
    } catch { return 0 }
}

function Find-Node {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Start-Refugio {
    $node = Find-Node
    if (-not $node -or -not (Test-Path $StartScript)) {
        [System.Windows.Forms.MessageBox]::Show(
            "Could not find Node.js or $StartScript.`n`nRe-run the REFUGIO installer.",
            "REFUGIO") | Out-Null
        return
    }
    Start-Process -FilePath $node -ArgumentList "`"$StartScript`"" `
        -WorkingDirectory $RefugioDir -WindowStyle Hidden
}

function Stop-Refugio {
    # The supervisor shuts its own children down; kill it by command line so we
    # don't take out unrelated node processes.
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -like "*start-refugio*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# ── Tray icon ────────────────────────────────────────────────

$icon = $null
$icoPath = Join-Path $RefugioDir "branding\favicon.ico"
if (Test-Path $icoPath) { $icon = New-Object System.Drawing.Icon($icoPath) }
if (-not $icon) { $icon = [System.Drawing.SystemIcons]::Application }

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icon
$tray.Visible = $true
$tray.Text = "REFUGIO"

$menu       = New-Object System.Windows.Forms.ContextMenuStrip
$miHeader   = $menu.Items.Add("REFUGIO - checking...")
$miHeader.Enabled = $false
$menu.Items.Add("-") | Out-Null
$miOpen     = $menu.Items.Add("Open REFUGIO")
$miToggle   = $menu.Items.Add("Start REFUGIO")
$menu.Items.Add("-") | Out-Null
$miStopQuit = $menu.Items.Add("Stop REFUGIO && Quit")
$miQuit     = $menu.Items.Add("Quit tray only (keeps running)")
$tray.ContextMenuStrip = $menu

$script:running = $false

$miOpen.Add_Click({
    $url = Get-RefugioUrl
    if ($url) { Start-Process $url } else { Start-Refugio }
})

$miToggle.Add_Click({
    if ($script:running) { Stop-Refugio } else { Start-Refugio }
})

$miStopQuit.Add_Click({
    Stop-Refugio
    Start-Sleep -Milliseconds 1500   # let the supervisor stop its children
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

$miQuit.Add_Click({
    if ($script:running) {
        $r = [System.Windows.Forms.MessageBox]::Show(
            "The tray icon will close but REFUGIO keeps running and keeps using memory.`n`nStop REFUGIO too?",
            "Leave REFUGIO running?",
            [System.Windows.Forms.MessageBoxButtons]::YesNoCancel)
        if ($r -eq "Cancel") { return }
        if ($r -eq "Yes") { Stop-Refugio; Start-Sleep -Milliseconds 1500 }
    }
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

# Double-click opens, matching normal tray behaviour.
$tray.Add_MouseDoubleClick({ $miOpen.PerformClick() })

# ── Status polling ───────────────────────────────────────────

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
    $up = (Get-RefugioUrl) -ne $null
    $script:running = $up
    if ($up) {
        $mb = Get-StackMemoryMB
        $miHeader.Text = if ($mb -gt 0) {
            "REFUGIO - running - {0:N1} GB RAM" -f ($mb / 1024)
        } else { "REFUGIO - running" }
        $miToggle.Text = "Stop REFUGIO"
        $tray.Text = "REFUGIO - running"
    } else {
        $miHeader.Text = "REFUGIO - stopped"
        $miToggle.Text = "Start REFUGIO"
        $tray.Text = "REFUGIO - stopped"
    }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
$tray.Visible = $false
$tray.Dispose()
