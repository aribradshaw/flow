import SwiftUI

// Everything waiting on you: your agents' questions and approvals, additions to approve, share
// requests, and the cards assigned to you (UAT first).
struct InboxScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Binding var path: NavigationPath
    @State private var inbox = InboxStore.shared
    @State private var error: String?
    @State private var replyTo: WaitingAgent?
    @State private var reply = ""
    @State private var busy: Set<String> = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).font(.footnote)
                }
                if !inbox.agents.isEmpty {
                    Section("Agents waiting on you") {
                        ForEach(inbox.agents) { agent in agentRow(agent) }
                    }
                }
                if !inbox.proposals.isEmpty {
                    Section("Additions to approve") {
                        ForEach(inbox.proposals) { p in proposalRow(p) }
                    }
                }
                if !inbox.shareRequests.isEmpty {
                    Section("Share requests") {
                        ForEach(inbox.shareRequests) { r in shareRow(r) }
                    }
                }
                let groups = Dictionary(grouping: inbox.cards, by: \.column)
                ForEach(["uat", "blocked", "doing", "requests", "must", "nice"], id: \.self) { col in
                    if let cards = groups[col], !cards.isEmpty {
                        Section(col == "uat" ? "Ready for you to test" : "Your cards · \(BoardColumn(rawValue: col)?.title ?? col)") {
                            ForEach(cards) { card in
                                NavigationLink(value: CardRef(env: card.env, id: card.id)) { cardRow(card) }
                            }
                        }
                    }
                }
            }
            .overlay {
                if inbox.loaded && inbox.count == 0 && inbox.cards.isEmpty {
                    ContentUnavailableView("Nothing waiting on you", systemImage: "tray",
                                           description: Text("Agents that need you, approvals, and cards assigned to you show up here."))
                } else if !inbox.loaded && inbox.loading {
                    ProgressView()
                }
            }
            .navigationTitle("Inbox")
            .navigationDestination(for: CardRef.self) { ref in CardDetailView(ref: ref) }
            .refreshable { await load() }
            .task { await load() }
            .onChange(of: scenePhase) { if scenePhase == .active { Task { await load() } } }
            .alert("Reply to \(replyTo?.name ?? "the agent")", isPresented: Binding(get: { replyTo != nil }, set: { if !$0 { replyTo = nil } }), presenting: replyTo) { agent in
                TextField("Your answer", text: $reply)
                Button("Send") { Task { await send(agent, kind: "message", text: reply) } }
                Button("Cancel", role: .cancel) {}
            } message: { agent in
                Text(agent.pending?.summary ?? "")
            }
        }
    }

    private func agentRow(_ agent: WaitingAgent) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: agent.isQuestion ? "questionmark.bubble" : "hand.raised")
                    .foregroundStyle(.orange)
                Text(agent.name).font(.headline).lineLimit(2)
                Spacer()
                if let host = agent.host { Text(host).font(.caption).foregroundStyle(.secondary) }
            }
            if let summary = agent.pending?.summary, !summary.isEmpty {
                Text(summary)
                    .font(.callout.monospaced())
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.fill.tertiary, in: .rect(cornerRadius: 8))
            }
            HStack {
                if agent.isQuestion {
                    Button("Reply") { reply = ""; replyTo = agent }
                        .buttonStyle(.borderedProminent)
                } else {
                    Button("Allow") { Task { await send(agent, decision: "allow") } }
                        .buttonStyle(.borderedProminent)
                    Button("Deny", role: .destructive) { Task { await send(agent, decision: "deny") } }
                        .buttonStyle(.bordered)
                }
            }
            .disabled(busy.contains(agent.source + agent.id))
        }
        .padding(.vertical, 4)
    }

    private func proposalRow(_ p: Proposal) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(p.proposedBy) added \(summary(p))").font(.subheadline)
            if let env = model.envs.first(where: { $0.id == p.env }) {
                Text(env.name).font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Button("Approve") { Task { await decide(p, approve: true) } }.buttonStyle(.borderedProminent)
                Button("Deny", role: .destructive) { Task { await decide(p, approve: false) } }.buttonStyle(.bordered)
            }
            .disabled(busy.contains(p.id))
        }
        .padding(.vertical, 4)
    }

    private func summary(_ p: Proposal) -> String {
        let names = (p.preview ?? []).map(\.label)
        if names.isEmpty { return "to a share" }
        return names.count == 1 ? "\"\(names[0])\"" : "\"\(names[0])\" and \(names.count - 1) more"
    }

    private func shareRow(_ r: ShareRequest) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(r.requestedBy) asks to share with \(r.toEmail) (\(r.permission))").font(.subheadline)
            if let note = r.note, !note.isEmpty { Text(note).font(.caption).foregroundStyle(.secondary) }
            HStack {
                Button("Approve") { Task { await decide(r, approve: true) } }.buttonStyle(.borderedProminent)
                Button("Deny", role: .destructive) { Task { await decide(r, approve: false) } }.buttonStyle(.bordered)
            }
            .disabled(busy.contains(r.id))
        }
        .padding(.vertical, 4)
    }

    private func cardRow(_ card: InboxCard) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(card.numberText).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Text(card.title).font(.subheadline.weight(.medium)).lineLimit(2)
            }
            HStack(spacing: 6) {
                if let p = card.project {
                    Circle().fill(Color(flow: p.color)).frame(width: 8, height: 8)
                    Text(p.name)
                }
                if let env = card.envName, model.envs.count > 1 { Text("· \(env)") }
                Text("· \(card.roles.joined(separator: ", "))")
                if let due = card.due, !due.isEmpty { Text("· due \(due)") }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            if model.envs.isEmpty { try await model.loadEnvs() }
            try await inbox.load(api, envs: model.envs)
            error = nil
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }

    private func send(_ agent: WaitingAgent, decision: String? = nil, kind: String? = nil, text: String? = nil) async {
        guard let api = model.api else { return }
        let key = agent.source + agent.id
        busy.insert(key)
        defer { busy.remove(key) }
        do {
            try await api.answer(.init(source: agent.source, agentId: agent.id, requestId: decision == nil ? nil : agent.pending?.requestId,
                                       decision: decision, kind: kind, text: text))
            inbox.remove(agent: agent)
            error = nil
        } catch {
            self.error = error.localizedDescription
            await load()
        }
    }

    private func decide(_ p: Proposal, approve: Bool) async {
        guard let api = model.api else { return }
        busy.insert(p.id)
        defer { busy.remove(p.id) }
        do { try await api.decide(env: p.env, proposal: p.id, approve: approve); inbox.remove(proposal: p) } catch { self.error = error.localizedDescription }
    }

    private func decide(_ r: ShareRequest, approve: Bool) async {
        guard let api = model.api else { return }
        busy.insert(r.id)
        defer { busy.remove(r.id) }
        do { try await api.decide(shareRequest: r.id, approve: approve); inbox.remove(shareRequest: r) } catch { self.error = error.localizedDescription }
    }
}
