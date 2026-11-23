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

// MARK: The Flow app's own routes (/api/app, docs/ios-app.md)

struct AppInbox: Decodable {
    let agents: [WaitingAgent]
    let cards: [InboxCard]
    let push: PushState?

    struct PushState: Decodable {
        let enabled: Bool
    }
}

struct WaitingAgent: Decodable, Identifiable, Hashable {
    let id: String
    let source: String
    let title: String?
    let vendor: String?
    let host: String?
    let pending: Pending?

    struct Pending: Decodable, Hashable {
        let requestId: String
        let kind: String
        let summary: String?
    }

    var isQuestion: Bool { pending?.kind == "question" }
    var name: String { (title?.isEmpty == false ? title : nil) ?? vendor?.capitalized ?? "An agent" }
}

struct InboxCard: Decodable, Identifiable, Hashable {
    let env: String
    let envName: String?
    let id: String
    let number: Int?
    let title: String
    let column: String
    let roles: [String]
    let project: Project?
    let due: String?
    let snoozed: Bool?

    struct Project: Decodable, Hashable {
        let id: String
        let name: String
        let color: String?
    }

    var numberText: String { number.map { "#\($0)" } ?? "" }
}

struct Proposal: Decodable, Identifiable, Hashable {
    let id: String
    let env: String
    let proposedBy: String
    let status: String
    let role: String?
    let createdAt: String?
    let preview: [PreviewRecord]?

    struct PreviewRecord: Decodable, Hashable {
        let kind: String?
        let title: String?
        let name: String?
        var label: String { title ?? name ?? kind ?? "record" }
    }
}

struct ShareRequest: Decodable, Identifiable, Hashable {
    let id: String
    let requestedBy: String
    let toEmail: String
    let permission: String
    let note: String?
    let status: String
}

struct ShareRequests: Decodable {
    let requests: [ShareRequest]
}

struct NewCard: Encodable {
    var title: String
    var column: String
    var project: String?
    var description: String?
}

// cards.update: only the fields that changed are sent.
struct CardPatch: Encodable {
    var title: String?
    var description: String?
    var project: String?
    var labels: [String]?
    var points: Double??
    var due: String?
    var checklist: [ChecklistEdit]?
    var links: [LinkEdit]?
    var ifUpdated: String?

    struct ChecklistEdit: Encodable, Hashable, Identifiable {
        var id: String?
        var text: String
        var done: Bool
        // For the editor's rows only: never sent, never compared.
        var localID = UUID()

        init(id: String?, text: String, done: Bool) {
            self.id = id
            self.text = text
            self.done = done
        }

        static func == (a: Self, b: Self) -> Bool { a.id == b.id && a.text == b.text && a.done == b.done }
        func hash(into h: inout Hasher) { h.combine(id); h.combine(text); h.combine(done) }

        private enum CodingKeys: String, CodingKey { case id, text, done }
    }

    struct LinkEdit: Encodable, Hashable {
        var id: String?
        var kind: String?
        var url: String
    }

    // points: nil leaves it alone; .some(nil) clears it.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(description, forKey: .description)
        try c.encodeIfPresent(project, forKey: .project)
        try c.encodeIfPresent(labels, forKey: .labels)
        if let points { try c.encode(points, forKey: .points) }
        try c.encodeIfPresent(due, forKey: .due)
        try c.encodeIfPresent(checklist, forKey: .checklist)
        try c.encodeIfPresent(links, forKey: .links)
        try c.encodeIfPresent(ifUpdated, forKey: .ifUpdated)
    }

    private enum Key: String, CodingKey {
        case title, description, project, labels, points, due, checklist, links, ifUpdated
    }

    var isEmpty: Bool {
        title == nil && description == nil && project == nil && labels == nil && points == nil && due == nil && checklist == nil && links == nil
    }
}
