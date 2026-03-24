import Cocoa
import AVFoundation
import UserNotifications
import CoreGraphics
import ScreenCaptureKit
import Speech
import AVFAudio

// MARK: - Computer Use Engine (Free Stack - Ollama Vision)

struct ComputerAction {
    enum ActionType: String {
        case screenshot, mouseMove = "mouse_move", leftClick = "left_click"
        case rightClick = "right_click", doubleClick = "double_click"
        case typeText = "type", pressKey = "key", scroll
        case done, thinking
    }
    let type: ActionType
    var x: Int?
    var y: Int?
    var text: String?
    var direction: String?
    var reasoning: String?
}

class ComputerUseEngine {
    let ollamaURL: String
    let visionModel: String
    let displayWidth: Int = 1024
    let displayHeight: Int = 768

    var isRunning = false
    var onAction: ((ComputerAction) -> Void)?
    var onMessage: ((String) -> Void)?
    var onComplete: ((String) -> Void)?

    // Screen dimensions for coordinate scaling
    var screenWidth: CGFloat = 0
    var screenHeight: CGFloat = 0

    init(ollamaURL: String = "http://localhost:11434", visionModel: String = "minicpm-v") {
        self.ollamaURL = ollamaURL
        self.visionModel = visionModel

        if let screen = NSScreen.main {
            screenWidth = screen.frame.width
            screenHeight = screen.frame.height
        }
    }

    // MARK: - Screenshot Capture

    func captureScreen(completion: @escaping (String?) -> Void) {
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first else {
                    print("[lil-eight] No display found")
                    DispatchQueue.main.async { completion(nil) }
                    return
                }

                let filter = SCContentFilter(display: display, excludingWindows: [])
                let config = SCStreamConfiguration()
                config.width = displayWidth
                config.height = displayHeight
                config.showsCursor = true

                let image = try await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: config
                )

                let rep = NSBitmapImageRep(cgImage: image)
                let pngData = rep.representation(using: .png, properties: [:])
                DispatchQueue.main.async {
                    completion(pngData?.base64EncodedString())
                }
            } catch {
                print("[lil-eight] Screenshot error: \(error)")
                DispatchQueue.main.async { completion(nil) }
            }
        }
    }

    // MARK: - Mouse Control

    func moveMouse(to point: CGPoint) {
        let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                           mouseCursorPosition: point, mouseButton: .left)
        event?.post(tap: .cghidEventTap)
    }

    func leftClick(at point: CGPoint) {
        moveMouse(to: point)
        usleep(50000) // 50ms settle
        let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                          mouseCursorPosition: point, mouseButton: .left)
        let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                        mouseCursorPosition: point, mouseButton: .left)
        down?.post(tap: .cghidEventTap)
        usleep(30000)
        up?.post(tap: .cghidEventTap)
    }

    func rightClick(at point: CGPoint) {
        moveMouse(to: point)
        usleep(50000)
        let down = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown,
                          mouseCursorPosition: point, mouseButton: .right)
        let up = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp,
                        mouseCursorPosition: point, mouseButton: .right)
        down?.post(tap: .cghidEventTap)
        usleep(30000)
        up?.post(tap: .cghidEventTap)
    }

    func doubleClick(at point: CGPoint) {
        moveMouse(to: point)
        usleep(50000)
        for clickCount in [1, 2] as [Int64] {
            let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                              mouseCursorPosition: point, mouseButton: .left)
            down?.setIntegerValueField(.mouseEventClickState, value: clickCount)
            let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                            mouseCursorPosition: point, mouseButton: .left)
            up?.setIntegerValueField(.mouseEventClickState, value: clickCount)
            down?.post(tap: .cghidEventTap)
            usleep(30000)
            up?.post(tap: .cghidEventTap)
            usleep(30000)
        }
    }

    func scroll(direction: String, amount: Int = 3) {
        let dy: Int32 = direction == "up" ? Int32(amount) : direction == "down" ? Int32(-amount) : 0
        let dx: Int32 = direction == "left" ? Int32(amount) : direction == "right" ? Int32(-amount) : 0
        let event = CGEvent(scrollWheelEvent2Source: nil, units: .line,
                           wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
        event?.post(tap: .cgSessionEventTap)
    }

    // MARK: - Keyboard Control

    func typeText(_ text: String) {
        for char in text {
            var unicodeChars = Array(String(char).utf16)
            let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
            let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            keyDown?.keyboardSetUnicodeString(stringLength: unicodeChars.count, unicodeString: &unicodeChars)
            keyUp?.keyboardSetUnicodeString(stringLength: unicodeChars.count, unicodeString: &unicodeChars)
            keyDown?.post(tap: .cghidEventTap)
            usleep(10000)
            keyUp?.post(tap: .cghidEventTap)
            usleep(10000)
        }
    }

    func pressKey(_ keyName: String) {
        // Parse modifier+key combos like "cmd+c", "Return", "Tab"
        let parts = keyName.lowercased().split(separator: "+").map(String.init)
        var flags: CGEventFlags = []
        var keyCode: CGKeyCode = 0

        for part in parts {
            switch part {
            case "cmd", "command", "super": flags.insert(.maskCommand)
            case "ctrl", "control": flags.insert(.maskControl)
            case "alt", "option": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            case "return", "enter": keyCode = 0x24
            case "tab": keyCode = 0x30
            case "space": keyCode = 0x31
            case "delete", "backspace": keyCode = 0x33
            case "escape", "esc": keyCode = 0x35
            case "up": keyCode = 0x7E
            case "down": keyCode = 0x7D
            case "left": keyCode = 0x7B
            case "right": keyCode = 0x7C
            case "a": keyCode = 0x00
            case "b": keyCode = 0x0B
            case "c": keyCode = 0x08
            case "d": keyCode = 0x02
            case "e": keyCode = 0x0E
            case "f": keyCode = 0x03
            case "g": keyCode = 0x05
            case "h": keyCode = 0x04
            case "i": keyCode = 0x22
            case "j": keyCode = 0x26
            case "k": keyCode = 0x28
            case "l": keyCode = 0x25
            case "m": keyCode = 0x2E
            case "n": keyCode = 0x2D
            case "o": keyCode = 0x1F
            case "p": keyCode = 0x23
            case "q": keyCode = 0x0C
            case "r": keyCode = 0x0F
            case "s": keyCode = 0x01
            case "t": keyCode = 0x11
            case "u": keyCode = 0x20
            case "v": keyCode = 0x09
            case "w": keyCode = 0x0D
            case "x": keyCode = 0x07
            case "y": keyCode = 0x10
            case "z": keyCode = 0x06
            default: break
            }
        }

        let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
        down?.flags = flags
        up?.flags = flags
        down?.post(tap: .cghidEventTap)
        usleep(30000)
        up?.post(tap: .cghidEventTap)
    }

    // MARK: - Coordinate Scaling

    func scaleToScreen(_ x: Int, _ y: Int) -> CGPoint {
        let scaledX = CGFloat(x) * screenWidth / CGFloat(displayWidth)
        let scaledY = CGFloat(y) * screenHeight / CGFloat(displayHeight)
        return CGPoint(x: scaledX, y: scaledY)
    }

    // MARK: - Execute Action

    func execute(_ action: ComputerAction) {
        switch action.type {
        case .mouseMove:
            if let x = action.x, let y = action.y {
                moveMouse(to: scaleToScreen(x, y))
            }
        case .leftClick:
            if let x = action.x, let y = action.y {
                leftClick(at: scaleToScreen(x, y))
            }
        case .rightClick:
            if let x = action.x, let y = action.y {
                rightClick(at: scaleToScreen(x, y))
            }
        case .doubleClick:
            if let x = action.x, let y = action.y {
                doubleClick(at: scaleToScreen(x, y))
            }
        case .typeText:
            if let text = action.text { typeText(text) }
        case .pressKey:
            if let key = action.text { pressKey(key) }
        case .scroll:
            let dir = action.direction ?? "down"
            scroll(direction: dir)
        case .screenshot, .done, .thinking:
            break
        }
    }

    // MARK: - Vision Model Agent Loop

    func runTask(_ task: String) {
        guard !isRunning else {
            onMessage?("Already running a task")
            return
        }
        isRunning = true
        onMessage?("Starting: \(task)")

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.agentLoop(task: task, maxSteps: 15)
        }
    }

    func stop() {
        isRunning = false
        onMessage?("Stopped")
    }

    private func agentLoop(task: String, maxSteps: Int) {
        var conversationHistory: [[String: Any]] = []
        var stepCount = 0

        while isRunning && stepCount < maxSteps {
            stepCount += 1

            DispatchQueue.main.async { [weak self] in
                self?.onAction?(ComputerAction(type: .thinking, reasoning: "Step \(stepCount)..."))
            }

            // 1. Capture screenshot
            let semaphore = DispatchSemaphore(value: 0)
            var screenshotBase64: String?

            DispatchQueue.main.async { [weak self] in
                self?.captureScreen { base64 in
                    screenshotBase64 = base64
                    semaphore.signal()
                }
            }
            semaphore.wait()

            guard let base64 = screenshotBase64 else {
                DispatchQueue.main.async { [weak self] in
                    self?.onMessage?("Failed to capture screenshot")
                }
                break
            }

            // 2. Build prompt for vision model
            let systemPrompt = """
            You are a computer control agent. You see a screenshot of a macOS desktop (\(displayWidth)x\(displayHeight) pixels). You MUST respond with ONLY a JSON object. No text, no explanation, no markdown - JUST the JSON.

            Actions:
            {"action":"left_click","x":512,"y":384,"reasoning":"why"}
            {"action":"double_click","x":100,"y":200,"reasoning":"why"}
            {"action":"right_click","x":100,"y":200,"reasoning":"why"}
            {"action":"type","text":"hello","reasoning":"why"}
            {"action":"key","text":"cmd+space","reasoning":"why"}
            {"action":"key","text":"Return","reasoning":"why"}
            {"action":"scroll","direction":"down","reasoning":"why"}
            {"action":"done","reasoning":"task complete because..."}

            x,y are pixel coordinates from top-left corner. Respond with ONE JSON object only.
            """

            var messages: [[String: Any]] = [
                ["role": "system", "content": systemPrompt]
            ]

            // Add conversation history
            messages.append(contentsOf: conversationHistory)

            // Add current step with screenshot (Ollama format: images array)
            let prompt = stepCount == 1
                ? "TASK: \(task)\nLook at the screenshot. Respond with ONLY a JSON action object. No other text."
                : "Action done. New screenshot. Respond with ONLY a JSON action object. No other text."
            messages.append([
                "role": "user",
                "content": prompt,
                "images": [base64]
            ])

            // 3. Call Ollama vision API
            guard let responseText = callOllama(messages: messages) else {
                DispatchQueue.main.async { [weak self] in
                    self?.onMessage?("Model call failed - is Ollama running with \(self?.visionModel ?? "vision model")?")
                }
                break
            }

            // 4. Parse action from response
            guard let action = parseAction(responseText) else {
                DispatchQueue.main.async { [weak self] in
                    self?.onMessage?("Could not parse action: \(responseText.prefix(100))")
                }
                // Add to history and try again
                conversationHistory.append(["role": "user", "content": "Task: \(task)"])
                conversationHistory.append(["role": "assistant", "content": responseText])
                continue
            }

            // 5. Report action
            DispatchQueue.main.async { [weak self] in
                let desc = action.reasoning ?? action.type.rawValue
                self?.onMessage?("[\(stepCount)] \(desc)")
                self?.onAction?(action)
            }

            // 6. Check if done
            if action.type == .done {
                DispatchQueue.main.async { [weak self] in
                    self?.isRunning = false
                    self?.onComplete?(action.reasoning ?? "Task complete")
                }
                return
            }

            // 7. Execute action
            DispatchQueue.main.async { [weak self] in
                self?.execute(action)
            }

            // Add to history (without image to save context)
            conversationHistory.append(["role": "user", "content": "Task: \(task). Step \(stepCount)."])
            conversationHistory.append(["role": "assistant", "content": responseText])

            // Brief pause for UI to update
            Thread.sleep(forTimeInterval: 0.5)
        }

        DispatchQueue.main.async { [weak self] in
            self?.isRunning = false
            if stepCount >= maxSteps {
                self?.onMessage?("Reached max steps (\(maxSteps))")
            }
        }
    }

    // MARK: - Ollama API Call

    private func callOllama(messages: [[String: Any]]) -> String? {
        let url = URL(string: "\(ollamaURL)/api/chat")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 120

        let body: [String: Any] = [
            "model": visionModel,
            "messages": messages,
            "stream": false,
            "options": ["temperature": 0.1, "num_predict": 256]
        ]

        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        request.httpBody = bodyData

        let semaphore = DispatchSemaphore(value: 0)
        var result: String?

        URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let message = json["message"] as? [String: Any],
                  let content = message["content"] as? String else { return }
            result = content
        }.resume()

        semaphore.wait()
        return result
    }

    // MARK: - Parse Action JSON

    private func parseAction(_ text: String) -> ComputerAction? {
        // Safe JSON extraction
        var jsonStr = text
        if let startIdx = text.firstIndex(of: "{"),
           let endIdx = text.lastIndex(of: "}"),
           startIdx <= endIdx {
            jsonStr = String(text[startIdx...endIdx])
        }

        guard let data = jsonStr.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let actionStr = json["action"] as? String,
              let actionType = ComputerAction.ActionType(rawValue: actionStr) else {
            return nil
        }

        return ComputerAction(
            type: actionType,
            x: json["x"] as? Int,
            y: json["y"] as? Int,
            text: json["text"] as? String,
            direction: json["direction"] as? String,
            reasoning: json["reasoning"] as? String
        )
    }
}

// MARK: - Sprite Animation

struct SpriteAnimation {
    let name: String
    let frames: [NSImage]
    let frameDuration: TimeInterval
}

class SpriteManager {
    let frameSize: CGFloat = 64
    var animations: [String: SpriteAnimation] = [:]

    func loadFromAtlas(path: String, manifestPath: String) {
        guard let atlasImage = NSImage(contentsOfFile: path),
              let manifestData = try? Data(contentsOf: URL(fileURLWithPath: manifestPath)),
              let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: [String: Int]]
        else {
            print("[lil-eight] Failed to load sprite atlas from \(path)")
            return
        }

        for (name, info) in manifest {
            guard let start = info["start"], let count = info["count"] else { continue }
            var frames: [NSImage] = []

            for i in 0..<count {
                let frameX = CGFloat(start + i) * frameSize
                let img = NSImage(size: NSSize(width: frameSize, height: frameSize))
                img.lockFocus()
                atlasImage.draw(
                    in: NSRect(x: 0, y: 0, width: frameSize, height: frameSize),
                    from: NSRect(x: frameX, y: 0, width: frameSize, height: frameSize),
                    operation: .copy,
                    fraction: 1.0
                )
                img.unlockFocus()
                frames.append(img)
            }

            let fps: TimeInterval
            switch name {
            case let n where n.contains("walk"): fps = 0.12
            case "typing": fps = 0.1
            case "celebrate": fps = 0.1
            case "sleep": fps = 0.4
            default: fps = 0.25
            }
            animations[name] = SpriteAnimation(name: name, frames: frames, frameDuration: fps)
        }

        print("[lil-eight] Loaded \(animations.count) animations")
    }
}

// MARK: - Sound Manager

class SoundManager {
    var players: [String: AVAudioPlayer] = [:]
    var volume: Float = 0.25 // subtle by default
    var muted = false

    func loadSounds(fromDir dir: String) {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(atPath: dir) else {
            print("[lil-eight] No sounds directory at \(dir)")
            return
        }

        for file in files where file.hasSuffix(".mp3") || file.hasSuffix(".m4a") || file.hasSuffix(".wav") {
            let name = (file as NSString).deletingPathExtension
            let path = "\(dir)/\(file)"
            guard let url = URL(string: "file://\(path)"),
                  let player = try? AVAudioPlayer(contentsOf: url) else { continue }
            player.prepareToPlay()
            player.volume = volume
            players[name] = player
        }

        print("[lil-eight] Loaded \(players.count) sounds")
    }

    func play(_ name: String) {
        guard !muted, let player = players[name] else { return }
        player.volume = volume
        player.currentTime = 0
        player.play()
    }
}

// MARK: - Agent State

enum AgentState: String, CaseIterable {
    case idle
    case walkRight = "walk-right"
    case walkLeft = "walk-left"
    case think
    case success
    case error
    case sleep
    case wave
    case sit
    case celebrate
    case drag
    case typing
}

// MARK: - Character Skin

struct CharacterSkin {
    let name: String
    let atlasFile: String // e.g. "atlas.png" or "atlas-cyber.png"
}

// MARK: - Dock Pet Window (clickable + draggable)

class DockPetWindow: NSWindow {
    var onClicked: (() -> Void)?
    var onDragStarted: (() -> Void)?
    var onDragMoved: ((NSPoint) -> Void)?
    var onDragEnded: (() -> Void)?

    init(startX: CGFloat, dockY: CGFloat) {
        super.init(
            contentRect: NSRect(x: startX, y: dockY, width: 64, height: 64),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )

        self.isOpaque = false
        self.backgroundColor = .clear
        self.level = .statusBar
        self.hasShadow = false
        self.ignoresMouseEvents = false // Now clickable!
        self.collectionBehavior = [.canJoinAllSpaces, .stationary]
        self.isMovableByWindowBackground = false
        self.acceptsMouseMovedEvents = true
    }

    override var canBecomeKey: Bool { true }

    override func mouseDown(with event: NSEvent) {
        onDragStarted?()
    }

    override func mouseDragged(with event: NSEvent) {
        var origin = self.frame.origin
        origin.x += event.deltaX
        origin.y -= event.deltaY
        self.setFrameOrigin(origin)
        onDragMoved?(origin)
    }

    override func mouseUp(with event: NSEvent) {
        // If barely moved, treat as click
        if abs(event.deltaX) < 2 && abs(event.deltaY) < 2 {
            onClicked?()
        }
        onDragEnded?()
    }

    override func rightMouseUp(with event: NSEvent) {
        onRightClicked?(event)
    }

    var onRightClicked: ((NSEvent) -> Void)?
}

// MARK: - Name Label Window

class NameLabelWindow: NSWindow {
    let label: NSTextField

    init() {
        self.label = NSTextField(labelWithString: "")
        label.font = NSFont.systemFont(ofSize: 9, weight: .medium)
        label.textColor = .white
        label.backgroundColor = NSColor.black.withAlphaComponent(0.6)
        label.isBezeled = false
        label.drawsBackground = true
        label.alignment = .center
        label.sizeToFit()
        label.wantsLayer = true
        label.layer?.cornerRadius = 3

        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 80, height: 14),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )

        self.isOpaque = false
        self.backgroundColor = .clear
        self.level = .statusBar
        self.hasShadow = false
        self.ignoresMouseEvents = true
        self.collectionBehavior = [.canJoinAllSpaces, .stationary]
        self.contentView = label
    }

    func update(text: String, aboveWindow pet: NSWindow) {
        label.stringValue = text
        label.sizeToFit()

        var frame = self.frame
        frame.size.width = max(label.frame.width + 8, 40)
        frame.origin.x = pet.frame.midX - frame.width / 2
        frame.origin.y = pet.frame.maxY + 2
        self.setFrame(frame, display: true)
    }
}

// MARK: - Chat Message Model

struct ChatMessage {
    enum Role { case user, assistant, system }
    let role: Role
    var text: String
    var imageBase64: String? // for pasted images
    let timestamp: Date

    init(role: Role, text: String, imageBase64: String? = nil) {
        self.role = role
        self.text = text
        self.imageBase64 = imageBase64
        self.timestamp = Date()
    }
}

// MARK: - Chat Bubble View

class ChatBubbleView: NSView {
    let label: NSTextField
    let role: ChatMessage.Role

    init(message: ChatMessage, width: CGFloat) {
        self.role = message.role
        self.label = NSTextField(wrappingLabelWithString: message.text)

        super.init(frame: .zero)

        label.font = message.role == .system
            ? NSFont.systemFont(ofSize: 11, weight: .light)
            : NSFont.systemFont(ofSize: 12)
        label.textColor = message.role == .system ? .tertiaryLabelColor : .labelColor
        label.isSelectable = true
        label.maximumNumberOfLines = 0
        label.preferredMaxLayoutWidth = width - 80

        wantsLayer = true
        layer?.cornerRadius = 8

        switch message.role {
        case .user:
            layer?.backgroundColor = NSColor(red: 0.91, green: 0.38, blue: 0.04, alpha: 0.15).cgColor // orange tint
        case .assistant:
            layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        case .system:
            layer?.backgroundColor = NSColor.clear.cgColor
        }

        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)

        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
        ])
    }

    required init?(coder: NSCoder) { nil }
}

// MARK: - Chat Popover Content

class ChatPopoverView: NSView, NSTextFieldDelegate {
    var messages: [ChatMessage] = []
    let scrollView = NSScrollView()
    let messageStack = NSStackView()
    let inputField = NSTextField()
    let statusBar = NSTextField(labelWithString: "")
    let sendButton = NSButton(title: "\u{2191}", target: nil, action: nil) // arrow up = send
    let micButton = NSButton(title: "\u{1F3A4}", target: nil, action: nil) // mic icon
    let imageButton = NSButton(title: "\u{1F4F7}", target: nil, action: nil) // camera icon

    var onSendMessage: ((String) -> Void)?
    var onSendImage: ((String, String) -> Void)?
    var onVoiceStart: (() -> Void)?
    var isListening = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        setupUI()
    }

    required init?(coder: NSCoder) { nil }

    func setupUI() {
        // Status bar at top
        statusBar.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)
        statusBar.textColor = .tertiaryLabelColor
        statusBar.translatesAutoresizingMaskIntoConstraints = false

        // Message area
        messageStack.orientation = .vertical
        messageStack.alignment = .leading
        messageStack.spacing = 6
        messageStack.translatesAutoresizingMaskIntoConstraints = false

        let clipView = NSClipView()
        clipView.documentView = messageStack
        clipView.translatesAutoresizingMaskIntoConstraints = false

        scrollView.contentView = clipView
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        // Input area
        inputField.placeholderString = "Talk to Eight..."
        inputField.font = NSFont.systemFont(ofSize: 13)
        inputField.focusRingType = .none
        inputField.bezelStyle = .roundedBezel
        inputField.delegate = self
        inputField.translatesAutoresizingMaskIntoConstraints = false

        sendButton.bezelStyle = .rounded
        sendButton.font = NSFont.systemFont(ofSize: 16, weight: .bold)
        sendButton.toolTip = "Send (Enter)"
        sendButton.target = self
        sendButton.action = #selector(sendClicked)
        sendButton.translatesAutoresizingMaskIntoConstraints = false

        micButton.bezelStyle = .rounded
        micButton.font = NSFont.systemFont(ofSize: 14)
        micButton.toolTip = "Voice chat (hold to talk)"
        micButton.target = self
        micButton.action = #selector(micClicked)
        micButton.translatesAutoresizingMaskIntoConstraints = false

        imageButton.bezelStyle = .rounded
        imageButton.font = NSFont.systemFont(ofSize: 14)
        imageButton.toolTip = "Send image from clipboard"
        imageButton.target = self
        imageButton.action = #selector(imageClicked)
        imageButton.translatesAutoresizingMaskIntoConstraints = false

        let inputRow = NSStackView(views: [imageButton, inputField, micButton, sendButton])
        inputRow.orientation = .horizontal
        inputRow.spacing = 6
        inputRow.translatesAutoresizingMaskIntoConstraints = false

        addSubview(statusBar)
        addSubview(scrollView)
        addSubview(inputRow)

        NSLayoutConstraint.activate([
            statusBar.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            statusBar.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            statusBar.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),

            scrollView.topAnchor.constraint(equalTo: statusBar.bottomAnchor, constant: 6),
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            scrollView.bottomAnchor.constraint(equalTo: inputRow.topAnchor, constant: -6),

            messageStack.widthAnchor.constraint(equalTo: scrollView.widthAnchor, constant: -12),

            inputRow.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            inputRow.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            inputRow.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            inputRow.heightAnchor.constraint(equalToConstant: 28),

            inputField.heightAnchor.constraint(equalToConstant: 28),
            sendButton.widthAnchor.constraint(equalToConstant: 32),
            micButton.widthAnchor.constraint(equalToConstant: 32),
            imageButton.widthAnchor.constraint(equalToConstant: 32),
        ])

        // Welcome message
        appendMessage(ChatMessage(role: .system, text: "Click send or press Enter to chat with Eight"))
    }

    func updateStatus(sessionId: String, state: String, connected: Bool) {
        let dot = connected ? "+" : "x"
        statusBar.stringValue = "[\(dot)] \(sessionId) - \(state)"
    }

    func appendMessage(_ msg: ChatMessage) {
        messages.append(msg)
        let bubble = ChatBubbleView(message: msg, width: self.frame.width)
        bubble.translatesAutoresizingMaskIntoConstraints = false
        messageStack.addArrangedSubview(bubble)

        // Alignment: user messages right, assistant left
        if msg.role == .user {
            bubble.leadingAnchor.constraint(greaterThanOrEqualTo: messageStack.leadingAnchor, constant: 40).isActive = true
            bubble.trailingAnchor.constraint(equalTo: messageStack.trailingAnchor).isActive = true
        } else {
            bubble.leadingAnchor.constraint(equalTo: messageStack.leadingAnchor).isActive = true
            bubble.trailingAnchor.constraint(lessThanOrEqualTo: messageStack.trailingAnchor, constant: -40).isActive = true
        }

        // Scroll to bottom
        DispatchQueue.main.async {
            let maxScroll = self.messageStack.frame.height - self.scrollView.contentView.bounds.height
            if maxScroll > 0 {
                self.scrollView.contentView.scroll(to: NSPoint(x: 0, y: maxScroll))
            }
        }
    }

    func appendStreamChunk(_ chunk: String) {
        // Append to the last assistant message, or create one
        if let last = messages.last, last.role == .assistant,
           let lastBubble = messageStack.arrangedSubviews.last as? ChatBubbleView,
           lastBubble.role == .assistant {
            messages[messages.count - 1].text += chunk
            lastBubble.label.stringValue = messages[messages.count - 1].text
        } else {
            appendMessage(ChatMessage(role: .assistant, text: chunk))
        }

        // Scroll to bottom
        DispatchQueue.main.async {
            let maxScroll = self.messageStack.frame.height - self.scrollView.contentView.bounds.height
            if maxScroll > 0 {
                self.scrollView.contentView.scroll(to: NSPoint(x: 0, y: maxScroll))
            }
        }
    }

    @objc func sendClicked() {
        submitInput()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)) {
            submitInput()
            return true
        }
        return false
    }

    func submitInput() {
        let text = inputField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        appendMessage(ChatMessage(role: .user, text: text))
        inputField.stringValue = ""
        onSendMessage?(text)
    }

    // Camera button - explicitly grabs image from clipboard
    @objc func imageClicked() {
        let pb = NSPasteboard.general
        if let imgData = pb.data(forType: .png) ?? pb.data(forType: .tiff) {
            let base64 = imgData.base64EncodedString()
            let caption = inputField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            let displayText = caption.isEmpty ? "[image from clipboard]" : caption
            appendMessage(ChatMessage(role: .user, text: displayText, imageBase64: base64))
            inputField.stringValue = ""
            onSendImage?(base64, caption.isEmpty ? "What do you see in this image?" : caption)
        } else {
            appendMessage(ChatMessage(role: .system, text: "No image on clipboard. Copy an image first (Cmd+Shift+4)"))
        }
    }

    // Mic button - start/stop voice input
    @objc func micClicked() {
        if isListening {
            isListening = false
            micButton.title = "\u{1F3A4}"
            micButton.toolTip = "Voice chat"
            appendMessage(ChatMessage(role: .system, text: "Voice stopped"))
        } else {
            isListening = true
            micButton.title = "\u{1F534}" // red circle = recording
            micButton.toolTip = "Stop listening"
            appendMessage(ChatMessage(role: .system, text: "Listening... (speak then click again)"))
            onVoiceStart?()
        }
    }

    func stopListening() {
        isListening = false
        micButton.title = "\u{1F3A4}"
    }
}

// MARK: - Pet Controller

class PetController {
    let sessionId: String
    let window: DockPetWindow
    let nameLabel: NameLabelWindow
    let imageView: NSImageView
    let spriteManager: SpriteManager
    let soundManager: SoundManager

    var currentState: AgentState = .idle
    var currentFrame: Int = 0
    var animationTimer: Timer?

    // Chat popover
    let popover = NSPopover()
    let chatView = ChatPopoverView(frame: NSRect(x: 0, y: 0, width: 320, height: 400))
    var popoverShown = false
    var chatSessionId: String? // daemon session for this pet's chat

    // Movement
    var posX: CGFloat
    var posY: CGFloat
    var homeY: CGFloat // dock level - returns here after drag
    var walkDirection: CGFloat = 1.0
    var walkSpeed: CGFloat = 1.5
    var idleTimer: Timer?
    var isWalking = false
    var daemonDriven = false
    var isDragging = false

    // Idle personality
    var idleSeconds: TimeInterval = 0
    var lastActivityTime: Date = Date()

    // Bounds (multi-monitor aware)
    var minX: CGFloat
    var maxX: CGFloat

    // Activity
    var currentTool: String?
    var lastEventTime: Date = Date()

    weak var petManager: PetManager?

    init(sessionId: String, spriteManager: SpriteManager, soundManager: SoundManager, startX: CGFloat) {
        self.sessionId = sessionId
        self.spriteManager = spriteManager
        self.soundManager = soundManager

        // Multi-monitor: find the screen containing the Dock
        let screen = PetController.dockScreen()
        let dockHeight: CGFloat = 70

        self.minX = screen.frame.minX + 32
        self.maxX = screen.frame.maxX - 96
        self.posX = min(max(startX, self.minX), self.maxX)
        self.homeY = screen.frame.minY + dockHeight
        self.posY = self.homeY

        self.window = DockPetWindow(startX: self.posX, dockY: self.posY)
        self.nameLabel = NameLabelWindow()

        self.imageView = NSImageView(frame: NSRect(x: 0, y: 0, width: 64, height: 64))
        self.imageView.imageScaling = .scaleProportionallyUpOrDown
        self.window.contentView = imageView

        // Chat popover setup
        let vc = NSViewController()
        vc.view = chatView
        popover.contentViewController = vc
        popover.contentSize = NSSize(width: 320, height: 400)
        popover.behavior = .semitransient // stays open until clicked outside

        // Wire up chat send
        chatView.onSendMessage = { [weak self] text in
            self?.sendChatMessage(text)
        }
        chatView.onSendImage = { [weak self] base64, caption in
            self?.sendImageToVision(base64: base64, caption: caption)
        }
        chatView.onVoiceStart = { [weak self] in
            self?.startVoiceInput()
        }

        // Wire up click and drag
        window.onClicked = { [weak self] in self?.handleClick() }
        window.onDragStarted = { [weak self] in self?.handleDragStart() }
        window.onDragMoved = { [weak self] origin in self?.handleDragMove(origin) }
        window.onDragEnded = { [weak self] in self?.handleDragEnd() }
        window.onRightClicked = { [weak self] event in self?.handleRightClick(event) }

        window.orderFront(nil)
        nameLabel.orderFront(nil)

        let shortId = Self.shortId(sessionId)
        nameLabel.update(text: shortId, aboveWindow: window)

        startAnimationLoop()
        scheduleRandomBehavior()
        startIdleTracker()
    }

    static func dockScreen() -> NSScreen {
        // The Dock is on the screen with the menu bar (main screen)
        // Or we can check all screens and find the one with the lowest visible frame
        return NSScreen.main ?? NSScreen.screens.first!
    }

    static func shortId(_ id: String) -> String {
        id.count > 8 ? String(id.suffix(6)) : id
    }

    func startAnimationLoop() {
        animationTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            self?.advanceFrame()
        }
    }

    func advanceFrame() {
        let stateName = currentState.rawValue
        guard let anim = spriteManager.animations[stateName] ?? spriteManager.animations["idle"] else { return }
        currentFrame = (currentFrame + 1) % anim.frames.count
        imageView.image = anim.frames[currentFrame]

        if isDragging { return }

        if isWalking {
            posX += walkDirection * walkSpeed

            if posX <= minX {
                posX = minX
                walkDirection = 1.0
                setStateInternal(.walkRight)
            } else if posX >= maxX {
                posX = maxX
                walkDirection = -1.0
                setStateInternal(.walkLeft)
            }

            var frame = window.frame
            frame.origin.x = posX
            window.setFrame(frame, display: true)
            nameLabel.update(text: nameLabel.label.stringValue, aboveWindow: window)
        }

        // Gravity: if above dock level and not dragging, fall back down
        if posY > homeY && !isDragging {
            posY = max(homeY, posY - 3)
            var frame = window.frame
            frame.origin.y = posY
            window.setFrame(frame, display: true)
            nameLabel.update(text: nameLabel.label.stringValue, aboveWindow: window)
        }
    }

    func setState(_ state: AgentState) {
        setStateInternal(state)
    }

    private func setStateInternal(_ state: AgentState) {
        guard state != currentState else { return }
        currentState = state
        currentFrame = 0

        switch state {
        case .walkRight:
            isWalking = true
            walkDirection = 1.0
        case .walkLeft:
            isWalking = true
            walkDirection = -1.0
        default:
            isWalking = false
        }
    }

    // MARK: - Click/Drag Interaction

    func handleClick() {
        lastActivityTime = Date()
        idleSeconds = 0

        if popoverShown {
            popover.close()
            popoverShown = false
        } else {
            // Update status bar
            let connected = petManager?.daemonOnline ?? false
            chatView.updateStatus(
                sessionId: sessionId,
                state: currentState.rawValue,
                connected: connected
            )

            // Ensure we have a daemon session for chat
            if chatSessionId == nil && connected {
                ensureChatSession()
            }

            popover.show(
                relativeTo: imageView.bounds,
                of: imageView,
                preferredEdge: .maxY
            )
            popoverShown = true
            soundManager.play("hum")

            // Focus the input field
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self.chatView.inputField.becomeFirstResponder()
            }
        }
    }

    func ensureChatSession() {
        guard let manager = petManager else { return }

        if sessionId != "eight" {
            // Use this pet's existing daemon session
            chatSessionId = sessionId
        } else {
            // Create a new session for the default pet's chat
            manager.daemonClient.send(["type": "session:create", "channel": "lil-eight"])
        }
    }

    func sendChatMessage(_ text: String) {
        guard let manager = petManager else {
            chatView.appendMessage(ChatMessage(role: .system, text: "No manager"))
            return
        }

        // /do prefix - execute tasks via shell (the Eight way)
        if text.lowercased().hasPrefix("/do ") {
            let task = String(text.dropFirst(4))
            onThinking()
            manager.executeTask(task, pet: self)
            return
        }

        // /stop cancels running task
        if text.lowercased() == "/stop" {
            chatView.appendMessage(ChatMessage(role: .system, text: "Stopped"))
            return
        }

        // Regular chat - route to Ollama text model
        if !manager.daemonOnline {
            manager.chatLocally(text, pet: self)
            return
        }

        // If we don't have a session yet, create one and queue the message
        if chatSessionId == nil {
            ensureChatSession()
            // Queue - the session:created handler will pick this up
            pendingMessage = text
            chatView.appendMessage(ChatMessage(role: .system, text: "Creating session..."))
            return
        }

        // Send prompt to daemon
        manager.daemonClient.send([
            "type": "prompt",
            "text": text,
            "sessionId": chatSessionId!
        ])

        // Pet starts thinking
        onThinking()
    }

    var pendingMessage: String?

    // Real speech recognition state
    var speechRecognizer: SFSpeechRecognizer?
    var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    var recognitionTask: SFSpeechRecognitionTask?
    var audioEngine: AVAudioEngine?
    var silenceTimer: Timer?
    var voiceFinished = false // prevent double-handling

    func startVoiceInput() {
        // If already listening, stop and send
        if recognitionTask != nil {
            stopVoiceInput()
            return
        }

        // Request speech recognition permission
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                switch status {
                case .authorized:
                    self?.beginListening()
                case .denied, .restricted:
                    self?.chatView.appendMessage(ChatMessage(role: .system, text: "Speech recognition denied. Enable in System Settings > Privacy > Speech Recognition"))
                    self?.chatView.stopListening()
                case .notDetermined:
                    self?.chatView.appendMessage(ChatMessage(role: .system, text: "Requesting speech permission..."))
                @unknown default:
                    break
                }
            }
        }
    }

    func beginListening() {
        speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        guard let speechRecognizer = speechRecognizer, speechRecognizer.isAvailable else {
            chatView.appendMessage(ChatMessage(role: .system, text: "Speech recognition not available"))
            chatView.stopListening()
            return
        }

        audioEngine = AVAudioEngine()
        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()

        guard let recognitionRequest = recognitionRequest,
              let audioEngine = audioEngine else {
            chatView.stopListening()
            return
        }

        recognitionRequest.shouldReportPartialResults = true
        voiceFinished = false

        nameLabel.update(text: "listening...", aboveWindow: window)
        setState(.wave)
        eightLog("Voice: started listening")

        recognitionTask = speechRecognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            guard let self = self, !self.voiceFinished else { return }

            if let result = result {
                let transcript = result.bestTranscription.formattedString

                DispatchQueue.main.async {
                    self.chatView.inputField.stringValue = transcript

                    // Reset silence timer - auto-send after 1.5s of no new speech
                    self.silenceTimer?.invalidate()
                    if !transcript.isEmpty {
                        self.silenceTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in
                            guard let self = self, !self.voiceFinished else { return }
                            eightLog("Voice: silence detected, auto-sending")
                            self.finishVoiceInput(transcript: transcript)
                        }
                    }
                }

                if result.isFinal {
                    DispatchQueue.main.async {
                        self.silenceTimer?.invalidate()
                        self.finishVoiceInput(transcript: result.bestTranscription.formattedString)
                    }
                }
            }

            // Only show error if we haven't already finished successfully
            if error != nil && !self.voiceFinished {
                let currentText = self.chatView.inputField.stringValue
                DispatchQueue.main.async {
                    if !currentText.isEmpty {
                        self.finishVoiceInput(transcript: currentText)
                    }
                    // Don't show "didn't catch that" - just silently reset
                }
            }
        }

        // Configure audio input
        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            recognitionRequest.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
            eightLog("Voice: audio engine started")
        } catch {
            eightLog("Voice: audio engine failed: \(error)")
            chatView.appendMessage(ChatMessage(role: .system, text: "Mic access failed"))
            chatView.stopListening()
        }
    }

    func stopVoiceInput() {
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()

        // Wait briefly for final result, then force finish with what we have
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else { return }
            let currentText = self.chatView.inputField.stringValue
            if !currentText.isEmpty && self.recognitionTask != nil {
                self.finishVoiceInput(transcript: currentText)
            }
        }
    }

    func finishVoiceInput(transcript: String) {
        guard !voiceFinished else { return } // prevent double-fire
        voiceFinished = true
        silenceTimer?.invalidate()
        silenceTimer = nil
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine = nil

        chatView.stopListening()
        nameLabel.update(text: PetController.shortId(sessionId), aboveWindow: window)

        eightLog("Voice transcript: \(transcript)")

        if !transcript.isEmpty {
            chatView.inputField.stringValue = transcript
            chatView.submitInput()
        } else {
            setState(.idle)
        }
    }

    func sendImageToVision(base64: String, caption: String) {
        guard let manager = petManager else { return }
        onThinking()
        chatView.updateStatus(sessionId: sessionId, state: "analyzing image...", connected: manager.daemonOnline)

        // Call Ollama vision directly with the image
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            let url = URL(string: "\(manager.computerEngine.ollamaURL)/api/chat")!
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.timeoutInterval = 120

            let body: [String: Any] = [
                "model": manager.computerEngine.visionModel,
                "messages": [
                    ["role": "user", "content": caption, "images": [base64]]
                ],
                "stream": false,
                "options": ["temperature": 0.3, "num_predict": 512]
            ]

            guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
                DispatchQueue.main.async {
                    self.chatView.appendMessage(ChatMessage(role: .system, text: "Failed to build request"))
                }
                return
            }
            request.httpBody = bodyData

            URLSession.shared.dataTask(with: request) { data, response, error in
                DispatchQueue.main.async {
                    if let error = error {
                        self.chatView.appendMessage(ChatMessage(role: .system, text: "Vision error: \(error.localizedDescription)"))
                        self.onStream(chunk: nil, final: true)
                        return
                    }
                    guard let data = data,
                          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let message = json["message"] as? [String: Any],
                          let content = message["content"] as? String else {
                        self.chatView.appendMessage(ChatMessage(role: .system, text: "No response from vision model"))
                        self.onStream(chunk: nil, final: true)
                        return
                    }
                    self.chatView.appendMessage(ChatMessage(role: .assistant, text: content))
                    self.onStream(chunk: nil, final: true)
                }
            }.resume()
        }
    }

    func onChatSessionCreated(_ newSessionId: String) {
        chatSessionId = newSessionId
        chatView.appendMessage(ChatMessage(role: .system, text: "Session ready"))

        // Send any pending message
        if let pending = pendingMessage {
            pendingMessage = nil
            sendChatMessage(pending)
        }
    }

    func onChatStreamChunk(_ chunk: String) {
        chatView.appendStreamChunk(chunk)
    }

    func handleDragStart() {
        isDragging = true
        daemonDriven = false
        setStateInternal(.drag)
        // subtle - no sound for walk
    }

    func handleDragMove(_ origin: NSPoint) {
        posX = origin.x
        posY = origin.y
        nameLabel.update(text: nameLabel.label.stringValue, aboveWindow: window)
    }

    func handleDragEnd() {
        isDragging = false
        setStateInternal(.idle)
    }

    func handleRightClick(_ event: NSEvent) {
        let menu = NSMenu()

        let chatItem = NSMenuItem(title: "Chat", action: #selector(AppDelegate.rightClickChat(_:)), keyEquivalent: "")
        chatItem.representedObject = sessionId

        let walkItem = NSMenuItem(title: "Walk", action: #selector(AppDelegate.rightClickWalk(_:)), keyEquivalent: "")
        walkItem.representedObject = sessionId

        let celebrateItem = NSMenuItem(title: "Celebrate", action: #selector(AppDelegate.rightClickCelebrate(_:)), keyEquivalent: "")
        celebrateItem.representedObject = sessionId

        let sleepItem = NSMenuItem(title: "Sleep", action: #selector(AppDelegate.rightClickSleep(_:)), keyEquivalent: "")
        sleepItem.representedObject = sessionId

        menu.addItem(chatItem)
        menu.addItem(.separator())
        menu.addItem(walkItem)
        menu.addItem(celebrateItem)
        menu.addItem(sleepItem)
        menu.addItem(.separator())

        let restartItem = NSMenuItem(title: "Restart Lil Eight", action: #selector(AppDelegate.restartApp), keyEquivalent: "")
        menu.addItem(restartItem)

        let quitItem = NSMenuItem(title: "Quit Lil Eight", action: #selector(AppDelegate.quit), keyEquivalent: "q")
        menu.addItem(quitItem)

        // Show context menu at mouse location
        NSMenu.popUpContextMenu(menu, with: event, for: imageView)
    }

    // MARK: - Idle Personality

    func startIdleTracker() {
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self = self, !self.daemonDriven, !self.isDragging else { return }
            self.idleSeconds = Date().timeIntervalSince(self.lastActivityTime)
        }
    }

    func scheduleRandomBehavior() {
        let delay = Double.random(in: 4...10)
        idleTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            guard let self = self else { return }

            if self.daemonDriven || self.isDragging {
                self.scheduleRandomBehavior()
                return
            }

            // Idle personality based on how long idle
            if self.idleSeconds > 120 {
                // Very idle - go to sleep
                self.setStateInternal(.sleep)
                self.nameLabel.update(text: "zzz", aboveWindow: self.window)
            } else if self.idleSeconds > 60 {
                // Moderately idle - sit down
                self.setStateInternal(.sit)
                self.nameLabel.update(text: "chillin", aboveWindow: self.window)
            } else if self.idleSeconds > 30 && Bool.random() {
                // Occasionally wave
                self.setStateInternal(.wave)
                self.nameLabel.update(text: "hey!", aboveWindow: self.window)
                Timer.scheduledTimer(withTimeInterval: 2.0, repeats: false) { [weak self] _ in
                    guard let self = self else { return }
                    self.setStateInternal(.idle)
                    self.nameLabel.update(text: Self.shortId(self.sessionId), aboveWindow: self.window)
                }
            } else if self.isWalking {
                self.setStateInternal(.idle)
                self.nameLabel.update(text: Self.shortId(self.sessionId), aboveWindow: self.window)
            } else {
                // Walk randomly
                self.setStateInternal(Bool.random() ? .walkRight : .walkLeft)
            }

            self.scheduleRandomBehavior()
        }
    }

    // MARK: - Daemon Event Handlers

    func onThinking() {
        daemonDriven = true
        lastActivityTime = Date()
        idleSeconds = 0
        setStateInternal(.think)
        nameLabel.update(text: "thinking...", aboveWindow: window)
        // subtle - no sound for thinking
    }

    func onToolStart(tool: String) {
        daemonDriven = true
        lastActivityTime = Date()
        idleSeconds = 0
        currentTool = tool

        // Different animations per tool type
        switch tool {
        case "bash", "write", "edit":
            setStateInternal(.typing)
            walkSpeed = 1.5
        default:
            setStateInternal(Bool.random() ? .walkRight : .walkLeft)
            walkSpeed = 2.0
        }

        let displayTool = tool.count > 10 ? String(tool.prefix(10)) : tool
        nameLabel.update(text: displayTool, aboveWindow: window)
        // subtle - no sound for tool use
    }

    func onToolResult(tool: String) {
        lastActivityTime = Date()
        currentTool = nil
        walkSpeed = 1.5
    }

    func onStream(chunk: String?, final: Bool) {
        lastActivityTime = Date()
        idleSeconds = 0

        // Route text to chat window
        if let chunk = chunk, !chunk.isEmpty {
            onChatStreamChunk(chunk)
        }

        if final {
            setStateInternal(.celebrate)
            nameLabel.update(text: "done!", aboveWindow: window)
            soundManager.play("hum")
            Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { [weak self] _ in
                guard let self = self else { return }
                self.daemonDriven = false
                self.setStateInternal(.idle)
                self.nameLabel.update(text: Self.shortId(self.sessionId), aboveWindow: self.window)
            }
        } else {
            setStateInternal(.typing)
            nameLabel.update(text: "writing...", aboveWindow: window)
        }
    }

    func onError() {
        daemonDriven = true
        lastActivityTime = Date()
        setStateInternal(.error)
        nameLabel.update(text: "error!", aboveWindow: window)
        soundManager.play("hum")
        Timer.scheduledTimer(withTimeInterval: 3.0, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.daemonDriven = false
            self.setStateInternal(.idle)
            self.nameLabel.update(text: Self.shortId(self.sessionId), aboveWindow: self.window)
        }
    }

    func onSessionEnd() {
        daemonDriven = false
        setStateInternal(.wave)
        nameLabel.update(text: "bye!", aboveWindow: window)
        Timer.scheduledTimer(withTimeInterval: 2.0, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.setStateInternal(.idle)
            self.nameLabel.update(text: Self.shortId(self.sessionId), aboveWindow: self.window)
        }
    }

    func onMemorySaved() {
        lastActivityTime = Date()
        let prev = currentState
        setStateInternal(.success)
        nameLabel.update(text: "memory!", aboveWindow: window)
        // subtle - no sound for memory
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.setStateInternal(prev)
            self.nameLabel.update(text: Self.shortId(self.sessionId), aboveWindow: self.window)
        }
    }

    func onApprovalRequired(tool: String) {
        daemonDriven = true
        setStateInternal(.wave) // wave for attention
        walkSpeed = 0
        nameLabel.update(text: "approve?", aboveWindow: window)
        soundManager.play("hum")
    }

    func destroy() {
        animationTimer?.invalidate()
        idleTimer?.invalidate()
        popover.close()
        window.orderOut(nil)
        nameLabel.orderOut(nil)
    }
}

// MARK: - Daemon WebSocket Client

class DaemonClient {
    var webSocket: URLSessionWebSocketTask?
    var urlSession: URLSession?
    var isConnected = false
    var reconnectTimer: Timer?
    var pingTimer: Timer?

    let port: Int
    let authToken: String?

    weak var delegate: DaemonClientDelegate?

    init(port: Int = 18789, authToken: String? = nil) {
        self.port = port
        self.authToken = authToken
    }

    func connect() {
        let url = URL(string: "ws://localhost:\(port)")!
        urlSession = URLSession(configuration: .default)
        webSocket = urlSession!.webSocketTask(with: url)
        webSocket?.resume()
        print("[lil-eight] Connecting to ws://localhost:\(port)...")

        if let token = authToken {
            send(["type": "auth", "token": token])
        }

        send(["type": "sessions:list"])
        receiveLoop()

        pingTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.send(["type": "ping"])
        }

        isConnected = true
        delegate?.daemonDidConnect()
    }

    func disconnect() {
        isConnected = false
        pingTimer?.invalidate()
        webSocket?.cancel(with: .normalClosure, reason: nil)
        webSocket = nil
    }

    func send(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let string = String(data: data, encoding: .utf8) else { return }
        webSocket?.send(.string(string)) { error in
            if let error = error {
                print("[lil-eight] Send error: \(error.localizedDescription)")
            }
        }
    }

    func receiveLoop() {
        webSocket?.receive { [weak self] result in
            guard let self = self else { return }

            switch result {
            case .success(.string(let text)):
                if let data = text.data(using: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    DispatchQueue.main.async {
                        self.handleMessage(json)
                    }
                }
            case .failure(let error):
                print("[lil-eight] WebSocket error: \(error.localizedDescription)")
                DispatchQueue.main.async {
                    self.isConnected = false
                    self.delegate?.daemonDidDisconnect()
                    self.scheduleReconnect()
                }
                return
            default:
                break
            }

            self.receiveLoop()
        }
    }

    func handleMessage(_ msg: [String: Any]) {
        guard let type = msg["type"] as? String else { return }

        switch type {
        case "auth:ok":
            print("[lil-eight] Authenticated")
            send(["type": "sessions:list"])

        case "auth:fail":
            print("[lil-eight] Auth failed!")

        case "sessions:list":
            if let sessions = msg["sessions"] as? [[String: Any]] {
                delegate?.daemonDidReceiveSessionList(sessions)
            }

        case "session:created":
            if let sessionId = msg["sessionId"] as? String {
                delegate?.daemonDidCreateSession(sessionId)
            }

        case "event":
            guard let event = msg["event"] as? String,
                  let payload = msg["payload"] as? [String: Any],
                  let sessionId = payload["sessionId"] as? String else { return }
            delegate?.daemonDidReceiveEvent(event: event, sessionId: sessionId, payload: payload)

        case "health":
            if let data = msg["data"] as? [String: Any] {
                delegate?.daemonDidReceiveHealth(data)
            }

        case "pong":
            break

        case "computer:screenshot":
            // Daemon requesting a screenshot from us
            let requestId = msg["requestId"] as? String ?? ""
            delegate?.daemonRequestsScreenshot(requestId: requestId)

        case "computer:action":
            // Daemon telling us to execute an action
            if let action = msg["action"] as? [String: Any] {
                delegate?.daemonRequestsAction(action)
            }

        case "error":
            let message = msg["message"] as? String ?? "unknown"
            print("[lil-eight] Daemon error: \(message)")

        default:
            break
        }
    }

    func sendScreenshot(requestId: String, base64: String) {
        send([
            "type": "computer:screenshot:result",
            "requestId": requestId,
            "image": base64,
            "width": 1024,
            "height": 768
        ])
    }

    func sendActionResult(success: Bool, message: String) {
        send([
            "type": "computer:action:result",
            "success": success,
            "message": message
        ])
    }

    func registerComputerUse() {
        // Tell the daemon we can provide screen control
        send([
            "type": "capabilities:register",
            "capabilities": ["computer_use"],
            "displayWidth": 1024,
            "displayHeight": 768
        ])
    }

    func scheduleReconnect() {
        reconnectTimer?.invalidate()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: false) { [weak self] _ in
            print("[lil-eight] Reconnecting...")
            self?.connect()
        }
    }

    func requestSessionList() {
        send(["type": "sessions:list"])
    }

    func requestHealth() {
        send(["type": "health"])
    }
}

protocol DaemonClientDelegate: AnyObject {
    func daemonDidConnect()
    func daemonDidDisconnect()
    func daemonDidReceiveSessionList(_ sessions: [[String: Any]])
    func daemonDidCreateSession(_ sessionId: String)
    func daemonDidReceiveEvent(event: String, sessionId: String, payload: [String: Any])
    func daemonDidReceiveHealth(_ data: [String: Any])
    func daemonRequestsScreenshot(requestId: String)
    func daemonRequestsAction(_ action: [String: Any])
}

// MARK: - Pet Manager (multi-agent orchestrator)

class PetManager: DaemonClientDelegate {
    let spriteManager: SpriteManager
    let soundManager: SoundManager
    let daemonClient: DaemonClient
    let computerEngine: ComputerUseEngine
    var pets: [String: PetController] = [:]
    var sessionCount: Int = 0
    var daemonOnline = false

    weak var appDelegate: AppDelegate?

    init(spriteManager: SpriteManager, soundManager: SoundManager) {
        self.spriteManager = spriteManager
        self.soundManager = soundManager
        self.computerEngine = ComputerUseEngine()

        let (port, token) = PetManager.readDaemonConfig()
        self.daemonClient = DaemonClient(port: port, authToken: token)
        self.daemonClient.delegate = self

        // Always spawn one default pet
        spawnPet(sessionId: "eight")

        // Try to start daemon if not running
        ensureDaemonRunning()

        daemonClient.connect()

        // Poll sessions every 10s
        Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.daemonClient.requestSessionList()
        }
    }

    // MARK: - Voice (Ava TTS)

    func speak(_ text: String) {
        // Truncate to 350 chars for TTS
        let cleaned = String(text.prefix(350))
            .replacingOccurrences(of: "\"", with: "'")
            .replacingOccurrences(of: "`", with: "")
        eightLog("speak: \(cleaned.prefix(80))")

        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
            process.arguments = ["-v", "Ava", "-r", "190", cleaned]
            try? process.run()
            process.waitUntilExit()
        }
    }

    // MARK: - Daemon Lifecycle

    func ensureDaemonRunning() {
        // Check if daemon is already listening
        let checkURL = URL(string: "http://localhost:18789/health")!
        var request = URLRequest(url: checkURL)
        request.timeoutInterval = 2

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                eightLog("Daemon already running")
                return
            }

            // Daemon not running - try to start it
            eightLog("Daemon not running, attempting to start...")
            self?.startDaemon()
        }.resume()
    }

    func startDaemon() {
        let eightCodePath = NSString(string: "~/8gent-code").expandingTildeInPath
        let daemonScript = "\(eightCodePath)/packages/daemon/index.ts"

        guard FileManager.default.fileExists(atPath: daemonScript) else {
            eightLog("Daemon script not found at \(daemonScript)")
            return
        }

        DispatchQueue.global(qos: .utility).async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/local/bin/bun")
            // Try common bun paths
            for bunPath in [
                "/usr/local/bin/bun",
                "/opt/homebrew/bin/bun",
                NSString(string: "~/.bun/bin/bun").expandingTildeInPath
            ] {
                if FileManager.default.fileExists(atPath: bunPath) {
                    process.executableURL = URL(fileURLWithPath: bunPath)
                    break
                }
            }

            process.arguments = ["run", daemonScript]
            process.currentDirectoryURL = URL(fileURLWithPath: eightCodePath)
            process.environment = ProcessInfo.processInfo.environment

            do {
                try process.run()
                eightLog("Daemon started (pid \(process.processIdentifier))")

                // Wait a moment then reconnect
                Thread.sleep(forTimeInterval: 3)
                DispatchQueue.main.async { [weak self] in
                    self?.daemonClient.connect()
                }
            } catch {
                eightLog("Failed to start daemon: \(error)")
            }
        }
    }

    static func readDaemonConfig() -> (Int, String?) {
        let configPath = NSString(string: "~/.8gent/config.json").expandingTildeInPath
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let daemon = json["daemon"] as? [String: Any] else {
            return (18789, nil)
        }
        let port = daemon["port"] as? Int ?? 18789
        let token = daemon["authToken"] as? String
        return (port, token)
    }

    func spawnPet(sessionId: String) {
        guard pets[sessionId] == nil else { return }

        let screen = NSScreen.main!
        let petCount = CGFloat(pets.count)
        let startX = screen.frame.midX + (petCount - 1) * 100

        let pet = PetController(
            sessionId: sessionId,
            spriteManager: spriteManager,
            soundManager: soundManager,
            startX: startX
        )
        pet.petManager = self
        pets[sessionId] = pet
        print("[lil-eight] Spawned pet for session: \(sessionId)")
        soundManager.play("hum")
        appDelegate?.updateMenu()
    }

    func despawnPet(sessionId: String) {
        guard let pet = pets[sessionId], sessionId != "eight" else { return }
        pet.destroy()
        pets.removeValue(forKey: sessionId)
        print("[lil-eight] Despawned pet for session: \(sessionId)")
        // subtle - no sound for disconnect
        appDelegate?.updateMenu()
    }

    // MARK: - DaemonClientDelegate

    func daemonDidConnect() {
        daemonOnline = true
        print("[lil-eight] Connected to Eight daemon")
        // Register that we can do computer use
        daemonClient.registerComputerUse()
        appDelegate?.updateMenu()
    }

    func daemonDidDisconnect() {
        daemonOnline = false
        print("[lil-eight] Disconnected from Eight daemon")
        appDelegate?.updateMenu()
    }

    func daemonDidReceiveSessionList(_ sessions: [[String: Any]]) {
        let activeIds = Set(sessions.compactMap { $0["sessionId"] as? String })
        sessionCount = activeIds.count

        for id in activeIds {
            spawnPet(sessionId: id)
        }

        for id in pets.keys where id != "eight" && !activeIds.contains(id) {
            despawnPet(sessionId: id)
        }

        appDelegate?.updateMenu()
    }

    func daemonDidCreateSession(_ sessionId: String) {
        // Check if any pet was waiting for a chat session
        for (_, pet) in pets {
            if pet.chatSessionId == nil && pet.pendingMessage != nil {
                pet.onChatSessionCreated(sessionId)
                return
            }
        }
        // Otherwise it's a new external session - spawn a pet
        spawnPet(sessionId: sessionId)
    }

    func daemonDidReceiveEvent(event: String, sessionId: String, payload: [String: Any]) {
        let pet = pets[sessionId] ?? pets["eight"]
        guard let targetPet = pet else { return }

        switch event {
        case "agent:thinking":
            targetPet.onThinking()

        case "tool:start":
            let tool = payload["tool"] as? String ?? "tool"
            targetPet.onToolStart(tool: tool)

        case "tool:result":
            let tool = payload["tool"] as? String ?? "tool"
            targetPet.onToolResult(tool: tool)

        case "agent:stream":
            let isFinal = payload["final"] as? Bool ?? false
            let chunk = payload["chunk"] as? String
            targetPet.onStream(chunk: chunk, final: isFinal)

        case "agent:error":
            targetPet.onError()

        case "memory:saved":
            targetPet.onMemorySaved()

        case "approval:required":
            let tool = payload["tool"] as? String ?? "action"
            targetPet.onApprovalRequired(tool: tool)
            sendNotification(title: "Lil Eight - Approval Needed", body: "Agent needs permission for: \(tool)")

        case "session:end":
            targetPet.onSessionEnd()
            let reason = payload["reason"] as? String ?? ""
            if reason == "client-destroy" || reason == "idle-timeout" {
                Timer.scheduledTimer(withTimeInterval: 5.0, repeats: false) { [weak self] _ in
                    self?.despawnPet(sessionId: sessionId)
                }
            }

        case "session:start":
            spawnPet(sessionId: sessionId)

        default:
            break
        }
    }

    func daemonDidReceiveHealth(_ data: [String: Any]) {
        let sessions = data["sessions"] as? Int ?? 0
        let uptime = data["uptime"] as? Double ?? 0
        let hours = Int(uptime / 3600)
        let mins = Int((uptime.truncatingRemainder(dividingBy: 3600)) / 60)
        print("[lil-eight] Health: \(sessions) sessions, up \(hours)h\(mins)m")
    }

    // MARK: - Computer Use (Daemon-driven)

    func daemonRequestsScreenshot(requestId: String) {
        print("[lil-eight] Daemon requesting screenshot (id: \(requestId))")
        computerEngine.captureScreen { [weak self] base64 in
            guard let base64 = base64 else {
                print("[lil-eight] Screenshot capture failed")
                return
            }
            self?.daemonClient.sendScreenshot(requestId: requestId, base64: base64)
            // subtle - no sound for tool use

            // Animate the default pet
            if let pet = self?.pets["eight"] {
                pet.onToolStart(tool: "screenshot")
            }
        }
    }

    func daemonRequestsAction(_ action: [String: Any]) {
        guard let actionStr = action["action"] as? String,
              let actionType = ComputerAction.ActionType(rawValue: actionStr) else {
            daemonClient.sendActionResult(success: false, message: "Unknown action")
            return
        }

        let computerAction = ComputerAction(
            type: actionType,
            x: action["x"] as? Int,
            y: action["y"] as? Int,
            text: action["text"] as? String,
            direction: action["direction"] as? String,
            reasoning: action["reasoning"] as? String
        )

        print("[lil-eight] Executing: \(actionStr) - \(computerAction.reasoning ?? "")")
        computerEngine.execute(computerAction)
        daemonClient.sendActionResult(success: true, message: actionStr)
        // subtle - no sound for tool use

        // Show what's happening on the default pet
        if let pet = pets["eight"] {
            let desc = computerAction.reasoning ?? actionStr
            pet.nameLabel.update(text: String(desc.prefix(12)), aboveWindow: pet.window)
        }
    }

    // MARK: - CLI Task Execution (the Eight way)

    private func ollamaChat(model: String, system: String, user: String, completion: @escaping (String?) -> Void) {
        guard let url = URL(string: "\(computerEngine.ollamaURL)/api/chat") else {
            completion(nil)
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 90

        let body: [String: Any] = [
            "model": model,
            "messages": [
                ["role": "system", "content": system],
                ["role": "user", "content": user]
            ],
            "stream": false,
            "options": ["temperature": 0.1, "num_predict": 300]
        ]

        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
            completion(nil)
            return
        }
        request.httpBody = bodyData

        URLSession.shared.dataTask(with: request) { data, _, error in
            guard error == nil,
                  let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let message = json["message"] as? [String: Any],
                  let content = message["content"] as? String else {
                completion(nil)
                return
            }
            completion(content)
        }.resume()
    }

    private func runShellCommand(_ cmd: String) -> String {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-c", cmd]
        process.standardOutput = pipe
        process.standardError = pipe
        process.environment = ProcessInfo.processInfo.environment

        do {
            try process.run()
            process.waitUntilExit()
            return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        } catch {
            return "Error: \(error.localizedDescription)"
        }
    }

    func executeTask(_ task: String, pet: PetController) {
        eightLog("executeTask: \(task)")
        pet.chatView.appendMessage(ChatMessage(role: .system, text: "On it..."))
        pet.onThinking()

        let systemPrompt = """
        You are Eight, an AI agent on macOS. Execute tasks using shell commands.
        Respond with ONLY a JSON object: {"commands": ["cmd1", "cmd2"], "explanation": "what this does"}

        Examples:
        User: open Safari -> {"commands": ["open -a Safari"], "explanation": "Opening Safari"}
        User: open chrome -> {"commands": ["open -a 'Google Chrome'"], "explanation": "Opening Chrome"}
        User: make folder eight on desktop -> {"commands": ["mkdir -p ~/Desktop/eight"], "explanation": "Creating folder"}
        User: what time is it -> {"commands": ["date"], "explanation": "Current time"}
        User: open google -> {"commands": ["open https://google.com"], "explanation": "Opening Google"}
        User: take screenshot -> {"commands": ["screencapture -x ~/Desktop/screenshot.png"], "explanation": "Screenshot saved"}
        User: play music -> {"commands": ["open -a Music"], "explanation": "Opening Music app"}

        ONLY output the JSON object. No markdown, no explanation, no backticks. Just the raw JSON.
        """

        ollamaChat(model: "qwen3.5", system: systemPrompt, user: task) { [weak self] response in
            guard let self = self else { return }

            guard let text = response else {
                eightLog("executeTask: Ollama offline/no response")
                DispatchQueue.main.async {
                    pet.chatView.appendMessage(ChatMessage(role: .system, text: "Ollama offline"))
                    pet.onStream(chunk: nil, final: true)
                }
                return
            }

            eightLog("executeTask response: \(text.prefix(200))")

            // Safe JSON extraction - find first { and last }
            let jsonStr: String
            if let startIdx = text.firstIndex(of: "{"),
               let endIdx = text.lastIndex(of: "}"),
               startIdx <= endIdx {
                jsonStr = String(text[startIdx...endIdx])
            } else {
                jsonStr = text
            }

            eightLog("executeTask JSON: \(jsonStr.prefix(200))")

            guard let jsonData = jsonStr.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let commands = parsed["commands"] as? [String] else {
                eightLog("executeTask: JSON parse failed, showing as text")
                // Model gave text - just show it
                DispatchQueue.main.async {
                    pet.chatView.appendMessage(ChatMessage(role: .assistant, text: text))
                    pet.onStream(chunk: nil, final: true)
                }
                return
            }

            let explanation = parsed["explanation"] as? String ?? "Running..."

            DispatchQueue.main.async { [weak self] in
                pet.chatView.appendMessage(ChatMessage(role: .assistant, text: explanation))
                pet.onToolStart(tool: "bash")
                self?.speak(explanation)
            }

            // Execute on background thread
            DispatchQueue.global(qos: .userInitiated).async {
                for cmd in commands {
                    DispatchQueue.main.async {
                        pet.chatView.appendMessage(ChatMessage(role: .system, text: "$ \(cmd)"))
                    }

                    let output = self.runShellCommand(cmd)
                    let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty {
                        DispatchQueue.main.async {
                            pet.chatView.appendMessage(ChatMessage(role: .system, text: String(trimmed.prefix(500))))
                        }
                    }

                    Thread.sleep(forTimeInterval: 0.3) // brief pause between commands
                }

                DispatchQueue.main.async {
                    pet.onStream(chunk: nil, final: true)
                    self.soundManager.play("hum")
                }
            }
        }
    }

    // MARK: - Local Chat (text model, no daemon)

    func chatLocally(_ text: String, pet: PetController) {
        pet.onThinking()

        ollamaChat(model: "qwen3.5", system: "You are Eight, a helpful AI assistant on macOS. Be concise and direct. Keep responses under 2 sentences.", user: text) { [weak self] response in
            DispatchQueue.main.async {
                let content = response ?? "Ollama offline - is it running?"
                pet.chatView.appendMessage(ChatMessage(role: .assistant, text: content))
                pet.onStream(chunk: nil, final: true)

                // Speak the response
                self?.speak(content)
            }
        }
    }

    // MARK: - Vision Computer Use (for /look commands)

    func runLocalComputerTask(_ task: String, pet: PetController) {
        // Direct Ollama vision loop - no daemon needed
        computerEngine.onMessage = { msg in
            DispatchQueue.main.async {
                pet.chatView.appendMessage(ChatMessage(role: .system, text: msg))
            }
        }
        computerEngine.onAction = { action in
            DispatchQueue.main.async {
                if action.type == .thinking {
                    pet.onThinking()
                } else {
                    pet.onToolStart(tool: action.type.rawValue)
                }
            }
        }
        computerEngine.onComplete = { [weak self] reason in
            DispatchQueue.main.async {
                pet.chatView.appendMessage(ChatMessage(role: .assistant, text: reason))
                pet.onStream(chunk: nil, final: true)
                self?.soundManager.play("hum")
            }
        }
        computerEngine.runTask(task)
    }

    func sendNotification(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        center.add(request)
    }
}

// MARK: - Agent Mesh Monitor (reads ~/.8gent/mesh/)

struct MeshAgentInfo {
    let id: String
    let type: String
    let name: String
    let pid: Int
    let cwd: String
    let capabilities: [String]
    let startedAt: Double
    let lastHeartbeat: Double

    var isStale: Bool { Date().timeIntervalSince1970 * 1000 - lastHeartbeat > 60000 }
    var uptimeStr: String {
        let secs = Int((Date().timeIntervalSince1970 * 1000 - startedAt) / 1000)
        if secs < 60 { return "\(secs)s" }
        if secs < 3600 { return "\(secs / 60)m" }
        return "\(secs / 3600)h\((secs % 3600) / 60)m"
    }
}

struct MeshMessageInfo {
    let id: String
    let from: String
    let to: String
    let type: String
    let content: String
    let timestamp: Double
}

class MeshMonitor {
    let meshDir: String
    var agents: [MeshAgentInfo] = []
    var recentMessages: [MeshMessageInfo] = []
    var pollTimer: Timer?

    var onUpdate: (() -> Void)?

    init() {
        let home = NSHomeDirectory()
        self.meshDir = "\(home)/.8gent/mesh"
    }

    func startMonitoring() {
        poll()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.poll()
        }
    }

    func stopMonitoring() {
        pollTimer?.invalidate()
    }

    func poll() {
        agents = readRegistry()
        recentMessages = readRecentBroadcasts(last: 20)
        onUpdate?()
    }

    func readRegistry() -> [MeshAgentInfo] {
        let path = "\(meshDir)/registry.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else {
            return []
        }

        return json.compactMap { (id, info) -> MeshAgentInfo? in
            guard let type = info["type"] as? String,
                  let name = info["name"] as? String,
                  let pid = info["pid"] as? Int,
                  let cwd = info["cwd"] as? String else { return nil }
            return MeshAgentInfo(
                id: id,
                type: type,
                name: name,
                pid: pid,
                cwd: cwd,
                capabilities: info["capabilities"] as? [String] ?? [],
                startedAt: info["startedAt"] as? Double ?? 0,
                lastHeartbeat: info["lastHeartbeat"] as? Double ?? 0
            )
        }
    }

    func readRecentBroadcasts(last n: Int) -> [MeshMessageInfo] {
        let broadcastDir = "\(meshDir)/broadcast"
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(atPath: broadcastDir) else { return [] }

        let sorted = files.filter { $0.hasSuffix(".json") }.sorted().suffix(n)
        return sorted.compactMap { file -> MeshMessageInfo? in
            let path = "\(broadcastDir)/\(file)"
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = json["id"] as? String,
                  let from = json["from"] as? String,
                  let to = json["to"] as? String,
                  let type = json["type"] as? String,
                  let content = json["content"] as? String else { return nil }
            return MeshMessageInfo(
                id: id, from: from, to: to, type: type,
                content: content, timestamp: json["timestamp"] as? Double ?? 0
            )
        }
    }

    // Send a message to a specific agent via filesystem
    func sendMessage(to agentId: String, type: String, content: String) {
        let inbox = "\(meshDir)/messages/\(agentId)"
        let fm = FileManager.default
        try? fm.createDirectory(atPath: inbox, withIntermediateDirectories: true)

        let msgId = "msg-\(Int(Date().timeIntervalSince1970 * 1000))"
        let msg: [String: Any] = [
            "id": msgId,
            "from": "lil-eight",
            "to": agentId,
            "type": type,
            "content": content,
            "timestamp": Date().timeIntervalSince1970 * 1000
        ]

        if let data = try? JSONSerialization.data(withJSONObject: msg, options: .prettyPrinted) {
            try? data.write(to: URL(fileURLWithPath: "\(inbox)/\(msgId).json"))
        }
    }

    // Broadcast to all agents
    func broadcast(type: String, content: String) {
        let broadcastDir = "\(meshDir)/broadcast"
        let fm = FileManager.default
        try? fm.createDirectory(atPath: broadcastDir, withIntermediateDirectories: true)

        let msgId = "msg-\(Int(Date().timeIntervalSince1970 * 1000))"
        let msg: [String: Any] = [
            "id": msgId,
            "from": "lil-eight",
            "to": "broadcast",
            "type": type,
            "content": content,
            "timestamp": Date().timeIntervalSince1970 * 1000
        ]

        if let data = try? JSONSerialization.data(withJSONObject: msg, options: .prettyPrinted) {
            try? data.write(to: URL(fileURLWithPath: "\(broadcastDir)/\(msgId).json"))
        }
    }
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    var petManager: PetManager?
    var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Enable standard Edit menu (Cmd+C, Cmd+V, Cmd+A, Cmd+X work in text fields)
        let mainMenu = NSMenu()
        let editMenuItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)
        NSApplication.shared.mainMenu = mainMenu

        // Menu bar
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem?.button {
            button.title = "8"
            button.font = NSFont.boldSystemFont(ofSize: 14)
        }

        // Load sprites
        let spriteManager = SpriteManager()
        let resourcePath = Bundle.main.resourcePath ?? "."
        spriteManager.loadFromAtlas(
            path: "\(resourcePath)/sprites/atlas.png",
            manifestPath: "\(resourcePath)/sprites/manifest.json"
        )

        if spriteManager.animations.isEmpty {
            let devPath = ProcessInfo.processInfo.environment["LIL_EIGHT_SPRITES"]
                ?? "\(FileManager.default.currentDirectoryPath)/sprites"
            spriteManager.loadFromAtlas(
                path: "\(devPath)/atlas.png",
                manifestPath: "\(devPath)/manifest.json"
            )
        }

        if spriteManager.animations.isEmpty {
            print("[lil-eight] No sprites! Run: bun run apps/lil-eight/generate-sprites.ts")
        }

        // Load sounds
        let soundManager = SoundManager()
        soundManager.loadSounds(fromDir: "\(resourcePath)/sounds")
        if soundManager.players.isEmpty {
            let devSounds = ProcessInfo.processInfo.environment["LIL_EIGHT_SOUNDS"]
                ?? "\(FileManager.default.currentDirectoryPath)/sounds"
            soundManager.loadSounds(fromDir: devSounds)
        }

        // Start
        petManager = PetManager(spriteManager: spriteManager, soundManager: soundManager)
        petManager?.appDelegate = self

        // Register for launch at login
        registerLaunchAtLogin()

        updateMenu()
    }

    func updateMenu() {
        let menu = NSMenu()

        let daemonStatus = (petManager?.daemonOnline ?? false) ? "Connected" : "Offline"
        let sessionCount = petManager?.sessionCount ?? 0
        let petCount = petManager?.pets.count ?? 0

        let header = NSMenuItem(title: "Lil Eight v0.2.0", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)

        let statusStr = "Daemon: \(daemonStatus) | \(sessionCount) sessions | \(petCount) pets"
        let statusItem = NSMenuItem(title: statusStr, action: nil, keyEquivalent: "")
        statusItem.isEnabled = false
        menu.addItem(statusItem)
        menu.addItem(.separator())

        // Sound controls
        let soundsMenu = NSMenu()
        let muteItem = NSMenuItem(
            title: (petManager?.soundManager.muted ?? false) ? "Unmute" : "Mute",
            action: #selector(toggleMute),
            keyEquivalent: "m"
        )
        soundsMenu.addItem(muteItem)

        let volUp = NSMenuItem(title: "Volume Up", action: #selector(volumeUp), keyEquivalent: "+")
        let volDown = NSMenuItem(title: "Volume Down", action: #selector(volumeDown), keyEquivalent: "-")
        soundsMenu.addItem(volUp)
        soundsMenu.addItem(volDown)

        let soundItem = NSMenuItem(title: "Sounds", action: nil, keyEquivalent: "")
        soundItem.submenu = soundsMenu
        menu.addItem(soundItem)

        menu.addItem(.separator())

        // Per-pet controls
        if let pets = petManager?.pets {
            for (id, pet) in pets.sorted(by: { $0.key < $1.key }) {
                let shortId = PetController.shortId(id)
                let stateStr = pet.currentState.rawValue
                let sub = NSMenu()

                for (label, action) in [
                    ("Walk", #selector(menuWalk(_:))),
                    ("Think", #selector(menuThink(_:))),
                    ("Type", #selector(menuType(_:))),
                    ("Celebrate", #selector(menuCelebrate(_:))),
                    ("Wave", #selector(menuWave(_:))),
                    ("Sit", #selector(menuSit(_:))),
                    ("Sleep", #selector(menuSleep(_:))),
                ] as [(String, Selector)] {
                    let item = NSMenuItem(title: label, action: action, keyEquivalent: "")
                    item.representedObject = id
                    item.target = self
                    sub.addItem(item)
                }

                let petItem = NSMenuItem(title: "\(shortId) (\(stateStr))", action: nil, keyEquivalent: "")
                petItem.submenu = sub
                menu.addItem(petItem)
            }
        }

        menu.addItem(.separator())
        menu.addItem(withTitle: "Refresh Sessions", action: #selector(refreshSessions), keyEquivalent: "r")
        menu.addItem(withTitle: "Reconnect Daemon", action: #selector(reconnectDaemon), keyEquivalent: "d")
        menu.addItem(.separator())

        let launchItem = NSMenuItem(
            title: "Launch at Login",
            action: #selector(toggleLaunchAtLogin),
            keyEquivalent: ""
        )
        launchItem.state = isLaunchAtLoginEnabled() ? .on : .off
        menu.addItem(launchItem)

        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(quit), keyEquivalent: "q")

        // Set targets
        for item in menu.items {
            if item.action != nil && item.target == nil {
                item.target = self
            }
            if let sub = item.submenu {
                for subItem in sub.items {
                    if subItem.action != nil && subItem.target == nil {
                        subItem.target = self
                    }
                }
            }
        }

        self.statusItem?.menu = menu
    }

    // MARK: - Pet Actions

    @objc func menuWalk(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let pet = petManager?.pets[id] else { return }
        pet.daemonDriven = false
        pet.setState(Bool.random() ? .walkRight : .walkLeft)
    }

    @objc func menuThink(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let pet = petManager?.pets[id] else { return }
        pet.onThinking()
    }

    @objc func menuType(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let pet = petManager?.pets[id] else { return }
        pet.daemonDriven = false
        pet.setState(.typing)
        pet.nameLabel.update(text: "typing...", aboveWindow: pet.window)
    }

    @objc func menuCelebrate(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let pet = petManager?.pets[id] else { return }
        pet.onStream(chunk: nil, final: true)
    }

    @objc func menuWave(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let pet = petManager?.pets[id] else { return }
        pet.daemonDriven = false
        pet.setState(.wave)
        pet.nameLabel.update(text: "hey!", aboveWindow: pet.window)
    }

    @objc func menuSit(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let pet = petManager?.pets[id] else { return }
        pet.daemonDriven = false
        pet.setState(.sit)
        pet.nameLabel.update(text: "chillin", aboveWindow: pet.window)
    }

    @objc func menuSleep(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let pet = petManager?.pets[id] else { return }
        pet.daemonDriven = false
        pet.setState(.sleep)
        pet.nameLabel.update(text: "zzz", aboveWindow: pet.window)
    }

    // MARK: - Sound Controls

    @objc func toggleMute() {
        guard let sm = petManager?.soundManager else { return }
        sm.muted = !sm.muted
        updateMenu()
    }

    @objc func volumeUp() {
        guard let sm = petManager?.soundManager else { return }
        sm.volume = min(1.0, sm.volume + 0.1)
        sm.play("ping-connect") // audible feedback
    }

    @objc func volumeDown() {
        guard let sm = petManager?.soundManager else { return }
        sm.volume = max(0.0, sm.volume - 0.1)
        sm.play("ping-connect")
    }

    // MARK: - Global

    @objc func refreshSessions() {
        petManager?.daemonClient.requestSessionList()
    }

    @objc func reconnectDaemon() {
        petManager?.daemonClient.disconnect()
        petManager?.daemonClient.connect()
    }

    @objc func quit() {
        NSApplication.shared.terminate(nil)
    }

    @objc func restartApp() {
        let appPath = Bundle.main.bundlePath
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = [appPath]
        try? task.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            NSApplication.shared.terminate(nil)
        }
    }

    // Right-click menu actions
    @objc func rightClickChat(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let pet = petManager?.pets[id] else { return }
        pet.handleClick()
    }

    @objc func rightClickWalk(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let pet = petManager?.pets[id] else { return }
        pet.daemonDriven = false
        pet.setState(Bool.random() ? .walkRight : .walkLeft)
    }

    @objc func rightClickCelebrate(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let pet = petManager?.pets[id] else { return }
        pet.onStream(chunk: nil, final: true)
    }

    @objc func rightClickSleep(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let pet = petManager?.pets[id] else { return }
        pet.daemonDriven = false
        pet.setState(.sleep)
        pet.nameLabel.update(text: "zzz", aboveWindow: pet.window)
    }

    // MARK: - Launch at Login

    func registerLaunchAtLogin() {
        // Use SMAppService on macOS 13+ or LaunchAgent plist
        let launchAgentDir = NSString(string: "~/Library/LaunchAgents").expandingTildeInPath
        let plistPath = "\(launchAgentDir)/dev.8gent.lil-eight.plist"

        if !FileManager.default.fileExists(atPath: plistPath) {
            // Don't auto-enable, just make the option available
            print("[lil-eight] Launch at login available via menu")
        }
    }

    func isLaunchAtLoginEnabled() -> Bool {
        let plistPath = NSString(string: "~/Library/LaunchAgents/dev.8gent.lil-eight.plist").expandingTildeInPath
        return FileManager.default.fileExists(atPath: plistPath)
    }

    @objc func toggleLaunchAtLogin() {
        let launchAgentDir = NSString(string: "~/Library/LaunchAgents").expandingTildeInPath
        let plistPath = "\(launchAgentDir)/dev.8gent.lil-eight.plist"

        if isLaunchAtLoginEnabled() {
            // Remove
            try? FileManager.default.removeItem(atPath: plistPath)
            print("[lil-eight] Removed launch at login")
        } else {
            // Create LaunchAgent plist
            try? FileManager.default.createDirectory(atPath: launchAgentDir, withIntermediateDirectories: true)
            let appPath = Bundle.main.bundlePath
            let plist = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
                <key>Label</key>
                <string>dev.8gent.lil-eight</string>
                <key>ProgramArguments</key>
                <array>
                    <string>open</string>
                    <string>\(appPath)</string>
                </array>
                <key>RunAtLoad</key>
                <true/>
            </dict>
            </plist>
            """
            try? plist.write(toFile: plistPath, atomically: true, encoding: .utf8)
            print("[lil-eight] Enabled launch at login")
        }

        updateMenu()
    }
}

// MARK: - File Logger

class FileLogger {
    static let shared = FileLogger()
    let logPath: String

    init() {
        let home = NSHomeDirectory()
        let dir = "\(home)/.8gent"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        logPath = "\(dir)/lil-eight.log"
        // Truncate on start
        try? "".write(toFile: logPath, atomically: true, encoding: .utf8)
    }

    func log(_ message: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let line = "[\(timestamp)] \(message)\n"
        print(line, terminator: "") // also print to stdout
        if let data = line.data(using: .utf8),
           let handle = FileHandle(forWritingAtPath: logPath) {
            handle.seekToEndOfFile()
            handle.write(data)
            handle.closeFile()
        } else {
            try? line.write(toFile: logPath, atomically: false, encoding: .utf8)
        }
    }
}

func eightLog(_ msg: String) {
    FileLogger.shared.log(msg)
}

// MARK: - Entry Point

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
