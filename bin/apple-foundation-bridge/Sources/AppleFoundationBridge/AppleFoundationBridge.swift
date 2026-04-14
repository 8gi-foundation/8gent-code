import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

// Apple Foundation Model bridge for 8gent-code.
//
// Transport: stdin/stdout JSON-line IPC.
// Each stdin line is one ChatRequest JSON object. Each stdout line is one
// ChatResponse JSON object. The 8gent runtime client spawns this binary once
// per session and multiplexes requests over the single subprocess.
//
// v1: non-streaming, single-turn per request, no tool calling.
// The TS client passes the full message history; we concatenate prior turns
// into a prompt string and send only the newest user turn through
// SystemLanguageModel. Multi-turn memory is the client's responsibility.

struct ChatMessage: Codable {
    let role: String
    let content: String
}

struct ChatRequest: Codable {
    let messages: [ChatMessage]
    let model: String?
    let maxTokens: Int?
    let temperature: Double?
}

struct ResponseMessage: Codable {
    let role: String
    let content: String
}

struct Usage: Codable {
    let prompt_tokens: Int
    let completion_tokens: Int
    let total_tokens: Int
}

struct ChatResponse: Codable {
    let model: String
    let message: ResponseMessage
    let done: Bool
    let usage: Usage?
    let error: String?
}

enum BridgeError: Error, CustomStringConvertible {
    case frameworkUnavailable
    case modelUnavailable(String)
    case emptyInput

    var description: String {
        switch self {
        case .frameworkUnavailable:
            return "FoundationModels framework not available on this OS (macOS 26+ required)."
        case .modelUnavailable(let reason):
            return "Apple system language model unavailable: \(reason)"
        case .emptyInput:
            return "Request contained no user message."
        }
    }
}

@main
struct AppleFoundationBridge {
    static func main() async {
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()

        while let line = readLine(strippingNewline: true) {
            if line.isEmpty { continue }

            let response = await handle(line: line, decoder: decoder)
            emit(response: response, encoder: encoder)
        }
    }

    static func handle(line: String, decoder: JSONDecoder) async -> ChatResponse {
        let modelName: String
        let messages: [ChatMessage]

        do {
            let data = Data(line.utf8)
            let req = try decoder.decode(ChatRequest.self, from: data)
            modelName = req.model ?? "apple-foundation-system"
            messages = req.messages
        } catch {
            return errorResponse(
                model: "apple-foundation-system",
                error: "failed to parse request: \(error)"
            )
        }

        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            return await respondViaFoundationModels(
                modelName: modelName,
                messages: messages
            )
        } else {
            return errorResponse(
                model: modelName,
                error: BridgeError.frameworkUnavailable.description
            )
        }
        #else
        return errorResponse(model: modelName, error: BridgeError.frameworkUnavailable.description)
        #endif
    }

    #if canImport(FoundationModels)
    @available(macOS 26.0, *)
    static func respondViaFoundationModels(
        modelName: String,
        messages: [ChatMessage]
    ) async -> ChatResponse {
        let systemInstructions = messages.first(where: { $0.role == "system" })?.content
        let conversation = messages.filter { $0.role != "system" }

        guard let lastUser = conversation.last(where: { $0.role == "user" }) else {
            return errorResponse(model: modelName, error: BridgeError.emptyInput.description)
        }

        let priorContext = buildPriorContext(conversation: conversation, lastUser: lastUser)
        let prompt = priorContext.isEmpty
            ? lastUser.content
            : "\(priorContext)\n\nUser: \(lastUser.content)"

        do {
            let model = SystemLanguageModel.default
            guard model.availability == .available else {
                return errorResponse(
                    model: modelName,
                    error: BridgeError.modelUnavailable("\(model.availability)").description
                )
            }

            let session: LanguageModelSession
            if let instructions = systemInstructions, !instructions.isEmpty {
                session = LanguageModelSession(model: model, instructions: instructions)
            } else {
                session = LanguageModelSession(model: model)
            }

            let result = try await session.respond(to: prompt)
            let content = result.content

            return ChatResponse(
                model: modelName,
                message: ResponseMessage(role: "assistant", content: content),
                done: true,
                usage: Usage(prompt_tokens: 0, completion_tokens: 0, total_tokens: 0),
                error: nil
            )
        } catch {
            return errorResponse(model: modelName, error: "\(error)")
        }
    }
    #endif

    static func buildPriorContext(conversation: [ChatMessage], lastUser: ChatMessage) -> String {
        // Include all turns except the final user message; that's what we pass directly.
        guard let lastIndex = conversation.lastIndex(where: { $0.role == "user" && $0.content == lastUser.content }) else {
            return ""
        }
        let priorTurns = conversation.prefix(lastIndex)
        return priorTurns.map { msg in
            let label = msg.role == "assistant" ? "Assistant" : "User"
            return "\(label): \(msg.content)"
        }.joined(separator: "\n")
    }

    static func errorResponse(model: String, error: String) -> ChatResponse {
        return ChatResponse(
            model: model,
            message: ResponseMessage(role: "assistant", content: ""),
            done: true,
            usage: nil,
            error: error
        )
    }

    static func emit(response: ChatResponse, encoder: JSONEncoder) {
        do {
            let data = try encoder.encode(response)
            if let line = String(data: data, encoding: .utf8) {
                print(line)
                fflush(stdout)
            }
        } catch {
            let fallback = "{\"model\":\"apple-foundation-system\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"error\":\"encoding failed: \(error)\"}"
            print(fallback)
            fflush(stdout)
        }
    }
}
