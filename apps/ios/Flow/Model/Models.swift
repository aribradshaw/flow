import Foundation

// Shapes returned by Flow's REST API v1 (docs/generated/api.md). Fields the app does not need are
// left out, and optional ones stay optional so a newer server never breaks decoding.

struct Page<Item: Decodable>: Decodable {
    let items: [Item]
    let nextCursor: String?
}

struct FlowEnv: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let visibility: String?
    let owner: String?
}

struct FlowProject: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let color: String?
}

struct FlowLabel: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let color: String?
}

struct FlowCard: Decodable, Identifiable, Hashable {
    let id: String
    let number: Int?
    let title: String
    let description: String?
    let column: String
    let project: String?
    let labels: [String]?
    let points: Double?
    let due: String?
    let assignees: [Assignee]?
    let checklist: [ChecklistItem]?
    let links: [CardLink]?
    let updated: String?
    let snoozedUntil: String?

    struct Assignee: Decodable, Hashable {
        let node: String
        let role: String?
    }

    struct ChecklistItem: Decodable, Hashable, Identifiable {
        let id: String
        let text: String
        let done: Bool
    }

    struct CardLink: Decodable, Hashable {
        let id: String?
        let kind: String?
        let url: String
    }

    var numberText: String { number.map { "#\($0)" } ?? "" }
}

struct CardEnvelope: Decodable {
    let card: FlowCard
}

// The DevOps board's columns, in board order (public/devops-core.js COLUMNS).
enum BoardColumn: String, CaseIterable, Identifiable {
    case requests, doing, blocked, uat, done, must, nice

    var id: String { rawValue }

    var title: String {
        switch self {
        case .must: "Backlog: Must Have"
        case .nice: "Backlog: Nice to Have"
        case .requests: "Requests"
        case .doing: "Doing"
        case .blocked: "Blocked"
        case .uat: "UAT"
        case .done: "Done"
        }
    }

    var systemImage: String {
        switch self {
        case .must: "exclamationmark.circle"
        case .nice: "sparkles"
        case .requests: "tray"
        case .doing: "hammer"
        case .blocked: "hand.raised"
        case .uat: "checkmark.seal"
        case .done: "checkmark.circle"
        }
    }
}

// /api/auth/session
struct AuthSession: Decodable {
    let mode: String
    let user: SessionUser?
    let sso: Bool?
    let device: Bool?
}

struct SessionUser: Decodable, Hashable {
    let email: String
    let name: String?
}

// The credential the native views use: an API key this app created for itself.
struct Credential: Codable, Equatable {
    let server: URL
    let key: String
    let keyId: String?
    let email: String?
    let prefix: String?
}
