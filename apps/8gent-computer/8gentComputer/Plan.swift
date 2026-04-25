// Plan.swift - Swift mirrors of packages/hands/types.ts.
//
// We decode the JSON RunResult written to stdout by `bun run packages/hands/run.ts`.
// Keep these structs aligned with packages/hands/types.ts. If a field is added
// there, mirror it here (Codable is forgiving about missing fields if optional).

import Foundation

struct PlannedStep: Codable, Hashable {
    let tool: String
    let args: [String: AnyCodable]?
    let rationale: String?
}

struct StepResult: Codable {
    let step: PlannedStep
    let ok: Bool
    let output: String?
    let imagePath: String?
    let error: String?
    let durationMs: Int
}

struct RunResult: Codable {
    let prompt: String
    let plannerMode: String
    let plannerModel: String?
    let plan: [PlannedStep]
    let results: [StepResult]
    let ok: Bool
    let startedAt: String
    let durationMs: Int
}

/// Tiny type-erased Codable so we can round-trip the args dict without a schema.
struct AnyCodable: Codable, Hashable {
    let value: Any

    init(_ value: Any) { self.value = value }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self.value = NSNull()
        } else if let b = try? c.decode(Bool.self) {
            self.value = b
        } else if let i = try? c.decode(Int.self) {
            self.value = i
        } else if let d = try? c.decode(Double.self) {
            self.value = d
        } else if let s = try? c.decode(String.self) {
            self.value = s
        } else if let arr = try? c.decode([AnyCodable].self) {
            self.value = arr.map { $0.value }
        } else if let dict = try? c.decode([String: AnyCodable].self) {
            self.value = dict.mapValues { $0.value }
        } else {
            self.value = NSNull()
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case is NSNull:                try c.encodeNil()
        case let b as Bool:            try c.encode(b)
        case let i as Int:             try c.encode(i)
        case let d as Double:          try c.encode(d)
        case let s as String:          try c.encode(s)
        case let arr as [Any]:         try c.encode(arr.map { AnyCodable($0) })
        case let dict as [String: Any]:try c.encode(dict.mapValues { AnyCodable($0) })
        default:                       try c.encodeNil()
        }
    }

    static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        // Cheap equality based on JSON encode. Good enough for SwiftUI diffing.
        let enc = JSONEncoder()
        return (try? enc.encode(lhs)) == (try? enc.encode(rhs))
    }

    func hash(into hasher: inout Hasher) {
        let enc = JSONEncoder()
        if let data = try? enc.encode(self) {
            hasher.combine(data)
        }
    }
}
