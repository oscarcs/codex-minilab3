import AppKit
import Foundation

private struct PresetMetadata: Decodable {
    let id: String
    let displayName: String
}

@main
private struct MenuBarLauncherMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = MenuBarLauncherDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
    }
}

private final class MenuBarLauncherDelegate: NSObject, NSApplicationDelegate {
    private let projectURL: URL
    private lazy var runtimeURL = projectURL.appendingPathComponent("node_modules/.bin/bun")
    private lazy var cliURL = projectURL.appendingPathComponent("src/cli.ts")
    private lazy var configURL = projectURL.appendingPathComponent("codex-minilab3.json")
    private let logURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/codex-minilab3.log")

    private var statusItem: NSStatusItem!
    private let statusMenuItem = NSMenuItem(title: "Hooked ChatGPT: Starting…", action: nil, keyEquivalent: "")
    private let restartMenuItem = NSMenuItem(title: "Restart Hooked ChatGPT", action: nil, keyEquivalent: "r")
    private var presetMenuItems: [String: NSMenuItem] = [:]
    private var selectedPresetID = ""
    private var launchProcess: Process?
    private var logHandle: FileHandle?
    private var restartRequested = false
    private var waitingForTerminationReply = false

    override init() {
        let configuredPath = Bundle.main.object(
            forInfoDictionaryKey: "CodexMiniLabProjectPath"
        ) as? String
        projectURL = URL(
            fileURLWithPath: configuredPath ?? FileManager.default.currentDirectoryPath,
            isDirectory: true
        )
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let presets = try loadPresets()
            guard !presets.isEmpty else {
                throw launcherError("No MiniLab lighting presets are registered")
            }
            selectedPresetID = try loadSelectedPresetID(fallback: presets[0].id)
            if !presets.contains(where: { $0.id == selectedPresetID }) {
                selectedPresetID = presets[0].id
                try writeSelectedPreset(selectedPresetID)
            }
            buildMenu(presets: presets)
            try startHookedChatGPT()
        } catch {
            showError(error)
            NSApp.terminate(nil)
        }
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        statusItem.button?.performClick(nil)
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let process = launchProcess, process.isRunning else { return .terminateNow }
        waitingForTerminationReply = true
        restartRequested = false
        statusMenuItem.title = "Hooked ChatGPT: Stopping…"
        process.terminate()
        return .terminateLater
    }

    private func buildMenu(presets: [PresetMetadata]) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(
                systemSymbolName: "waveform.circle.fill",
                accessibilityDescription: "ChatGPT MiniLab"
            )
            button.image?.isTemplate = true
            button.toolTip = "ChatGPT MiniLab"
        }

        let menu = NSMenu()
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())

        let presetHeading = NSMenuItem(title: "Lighting Preset", action: nil, keyEquivalent: "")
        presetHeading.isEnabled = false
        menu.addItem(presetHeading)
        for preset in presets {
            let item = NSMenuItem(
                title: preset.displayName,
                action: #selector(selectPreset(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = preset.id
            menu.addItem(item)
            presetMenuItems[preset.id] = item
        }
        updatePresetChecks()

        menu.addItem(.separator())
        restartMenuItem.target = self
        restartMenuItem.action = #selector(restartHookedChatGPT(_:))
        menu.addItem(restartMenuItem)

        let logItem = NSMenuItem(
            title: "Open Bridge Log",
            action: #selector(openLog(_:)),
            keyEquivalent: "l"
        )
        logItem.target = self
        menu.addItem(logItem)

        menu.addItem(.separator())
        let quitItem = NSMenuItem(
            title: "Quit Hooked ChatGPT",
            action: #selector(quitLauncher(_:)),
            keyEquivalent: "q"
        )
        quitItem.target = self
        menu.addItem(quitItem)
        statusItem.menu = menu
    }

    @objc private func selectPreset(_ sender: NSMenuItem) {
        guard let presetID = sender.representedObject as? String else { return }
        guard presetID != selectedPresetID else { return }
        do {
            try writeSelectedPreset(presetID)
            selectedPresetID = presetID
            updatePresetChecks()
            requestRestart()
        } catch {
            showError(error)
        }
    }

    @objc private func restartHookedChatGPT(_ sender: NSMenuItem) {
        requestRestart()
    }

    @objc private func openLog(_ sender: NSMenuItem) {
        NSWorkspace.shared.open(logURL)
    }

    @objc private func quitLauncher(_ sender: NSMenuItem) {
        NSApp.terminate(nil)
    }

    private func updatePresetChecks() {
        for (id, item) in presetMenuItems {
            item.state = id == selectedPresetID ? .on : .off
        }
    }

    private func requestRestart() {
        restartRequested = true
        statusMenuItem.title = "Hooked ChatGPT: Restarting…"
        restartMenuItem.isEnabled = false
        if let process = launchProcess, process.isRunning {
            process.terminate()
        } else {
            launchProcess = nil
            scheduleRestart()
        }
    }

    private func scheduleRestart() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            guard let self else { return }
            self.restartRequested = false
            do {
                try self.startHookedChatGPT()
            } catch {
                self.showError(error)
                self.statusMenuItem.title = "Hooked ChatGPT: Launch failed"
                self.restartMenuItem.title = "Launch Hooked ChatGPT"
                self.restartMenuItem.isEnabled = true
            }
        }
    }

    private func startHookedChatGPT() throws {
        guard FileManager.default.isExecutableFile(atPath: runtimeURL.path) else {
            throw launcherError("Project dependencies are missing. Run npm install in \(projectURL.path)")
        }
        try FileManager.default.createDirectory(
            at: logURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: logURL)
        try handle.seekToEnd()
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let heading = "\n[\(formatter.string(from: Date()))] Menu-bar launcher starting (\(selectedPresetID))\n"
        try handle.write(contentsOf: Data(heading.utf8))

        let process = Process()
        process.executableURL = runtimeURL
        process.arguments = [cliURL.path, "launch", "--config", configURL.path]
        process.currentDirectoryURL = projectURL
        process.standardOutput = handle
        process.standardError = handle
        process.terminationHandler = { [weak self, weak process] _ in
            DispatchQueue.main.async {
                guard let self, let process, self.launchProcess === process else { return }
                self.launchProcess = nil
                try? self.logHandle?.close()
                self.logHandle = nil
                if self.waitingForTerminationReply {
                    self.waitingForTerminationReply = false
                    NSApp.reply(toApplicationShouldTerminate: true)
                } else if self.restartRequested {
                    self.scheduleRestart()
                } else {
                    self.statusMenuItem.title = "Hooked ChatGPT: Stopped"
                    self.restartMenuItem.title = "Launch Hooked ChatGPT"
                    self.restartMenuItem.isEnabled = true
                }
            }
        }
        do {
            try process.run()
        } catch {
            try? handle.close()
            throw error
        }
        launchProcess = process
        logHandle = handle
        statusMenuItem.title = "Hooked ChatGPT: Running"
        restartMenuItem.title = "Restart Hooked ChatGPT"
        restartMenuItem.isEnabled = true
    }

    private func loadPresets() throws -> [PresetMetadata] {
        guard FileManager.default.isExecutableFile(atPath: runtimeURL.path) else {
            throw launcherError("Project dependencies are missing. Run npm install in \(projectURL.path)")
        }
        let output = Pipe()
        let errors = Pipe()
        let process = Process()
        process.executableURL = runtimeURL
        process.arguments = [cliURL.path, "lighting-presets", "--json"]
        process.currentDirectoryURL = projectURL
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        if process.terminationStatus != 0 {
            let detail = String(
                data: errors.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "unknown error"
            throw launcherError("Could not list lighting presets: \(detail)")
        }
        return try JSONDecoder().decode([PresetMetadata].self, from: data)
    }

    private func loadSelectedPresetID(fallback: String) throws -> String {
        guard FileManager.default.fileExists(atPath: configURL.path) else {
            try writeSelectedPreset(fallback)
            return fallback
        }
        let value = try JSONSerialization.jsonObject(with: Data(contentsOf: configURL))
        let root = value as? [String: Any]
        let controller = root?["controller"] as? [String: Any]
        return controller?["lightingPreset"] as? String
            ?? controller?["spectrumPreset"] as? String
            ?? fallback
    }

    private func writeSelectedPreset(_ presetID: String) throws {
        var root: [String: Any] = [:]
        if FileManager.default.fileExists(atPath: configURL.path) {
            let value = try JSONSerialization.jsonObject(with: Data(contentsOf: configURL))
            guard let object = value as? [String: Any] else {
                throw launcherError("\(configURL.lastPathComponent) must contain a JSON object")
            }
            root = object
        }
        var controller = root["controller"] as? [String: Any] ?? [:]
        if controller["type"] == nil { controller["type"] = "minilab3" }
        controller["lightingPreset"] = presetID
        controller.removeValue(forKey: "spectrumPreset")
        root["controller"] = controller
        let data = try JSONSerialization.data(
            withJSONObject: root,
            options: [.prettyPrinted, .sortedKeys]
        )
        try data.write(to: configURL, options: .atomic)
    }

    private func showError(_ error: Error) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "ChatGPT MiniLab"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

private func launcherError(_ message: String) -> NSError {
    NSError(
        domain: "ChatGPTMiniLabLauncher",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: message]
    )
}
