import BackgroundTasks
import Foundation
import Observation
import WidgetKit

// Where a notification tap or a widget link goes.
enum AppRoute: Equatable {
    case inbox
    case card(CardRef)

    // flowapp://inbox, flowapp://card?env=…&id=…
    init?(url: URL) {
        guard url.scheme == "flowapp" else { return nil }
        if url.host == "card", let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
           let env = q.first(where: { $0.name == "env" })?.value, let id = q.first(where: { $0.name == "id" })?.value {
            self = .card(CardRef(env: env, id: id))
        } else {
            self = .inbox
        }
    }
}

// A card anywhere: its environment and id. Navigation uses this, so a card from the inbox, a
// notification or a widget opens the same way as one on the board.
struct CardRef: Hashable {
    let env: String
    let id: String
}

// Everything waiting on this person (docs/ios-app.md): their agents, approvals, share requests and cards.
@MainActor
@Observable
final class InboxStore {
    static let shared = InboxStore()

    private(set) var agents: [WaitingAgent] = []
    private(set) var cards: [InboxCard] = []
    private(set) var proposals: [Proposal] = []
    private(set) var shareRequests: [ShareRequest] = []
    private(set) var pushEnabledOnServer: Bool?
    private(set) var loading = false
    private(set) var loaded = false

    var count: Int { agents.count + proposals.count + shareRequests.count + cards.filter { $0.column == "uat" }.count }

    func load(_ api: FlowAPI, envs: [FlowEnv]) async throws {
        loading = true
        defer { loading = false }
        let inbox = try await api.inbox()
        agents = inbox.agents
        cards = inbox.cards
        pushEnabledOnServer = inbox.push?.enabled
        // Approvals and share requests: best effort, one environment failing does not hide the rest.
        var found = [Proposal]()
        for env in envs.prefix(25) {
            if let list = try? await api.proposals(env: env.id) { found += list.filter { $0.role != "proposer" && $0.status == "pending" } }
        }
        proposals = found
        shareRequests = (try? await api.shareRequests()) ?? []
        loaded = true
        writeSnapshot()
    }

    func remove(agent: WaitingAgent) { agents.removeAll { $0.id == agent.id && $0.source == agent.source } ; writeSnapshot() }
    func remove(proposal: Proposal) { proposals.removeAll { $0.id == proposal.id } }
    func remove(shareRequest: ShareRequest) { shareRequests.removeAll { $0.id == shareRequest.id } }

    func clear() {
        agents = []; cards = []; proposals = []; shareRequests = []; loaded = false
        SharedStore.save(.empty)
        WidgetCenter.shared.reloadAllTimelines()
    }

    // The widgets' copy (Shared/WidgetSnapshot.swift).
    func writeSnapshot() {
        let link = { (c: InboxCard) in "flowapp://card?env=\(seg(c.env))&id=\(seg(c.id))" }
        let detail = { (c: InboxCard) in [BoardColumn(rawValue: c.column)?.title, c.project?.name].compactMap { $0 }.joined(separator: " · ") }
        let agentItems = agents.map {
            WidgetSnapshot.Item(id: "a-\($0.source)-\($0.id)", title: $0.isQuestion ? "\($0.name) asks" : "\($0.name) is waiting",
                                detail: $0.pending?.summary ?? "", kind: .agent, link: "flowapp://inbox")
        }
        let uat = cards.filter { $0.column == "uat" }, doing = cards.filter { $0.column == "doing" }
        let snapshot = WidgetSnapshot(updated: .now, signedIn: true, agentsWaiting: agents.count, uat: uat.count, doing: doing.count,
            waiting: agentItems + uat.map { .init(id: $0.id, title: "\($0.numberText) \($0.title)", detail: detail($0), kind: .uat, link: link($0)) },
            inProgress: doing.map { .init(id: $0.id, title: "\($0.numberText) \($0.title)", detail: $0.project?.name ?? "", kind: .doing, link: link($0)) })
        if snapshot.waiting.prefix(6) != SharedStore.load().waiting.prefix(6) || snapshot.inProgress.prefix(6) != SharedStore.load().inProgress.prefix(6) || snapshot.waitingCount != SharedStore.load().waitingCount {
            SharedStore.save(snapshot)
            WidgetCenter.shared.reloadAllTimelines()
        } else {
            SharedStore.save(snapshot)
        }
    }
}

// Keeps the widgets current while the app is closed: iOS runs this now and then (it decides when).
enum BackgroundRefresh {
    static let id = "com.flygonlc.flow.refresh"

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: id, using: nil) { task in
            schedule()
            let work = Task { @MainActor in
                guard let credential = Keychain.load() else { return }
                let api = FlowAPI(credential: credential)
                try? await InboxStore.shared.load(api, envs: (try? await api.envs()) ?? [])
            }
            task.expirationHandler = { work.cancel() }
            Task { _ = await work.value; task.setTaskCompleted(success: true) }
        }
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: id)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 20 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}
