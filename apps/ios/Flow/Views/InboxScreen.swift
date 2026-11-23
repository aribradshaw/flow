import SwiftUI

// Everything waiting on you: your agents' questions and approvals, additions to approve, share
// requests, and the cards assigned to you (ready to test first).
struct InboxScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Binding var path: NavigationPath
    @State private var inbox = InboxStore.shared
    @State private var error: String?
    @State private var replyTo: WaitingAgent?
    @State private var reply = ""
    @State private var busy: Set<String> = []
    @State private var answered = 0
    @State private var mover = CardMover()

    private var waitingCount: Int { inbox.agents.count + inbox.proposals.count + inbox.shareRequests.count + inbox.cards.filter { $0.column == "uat" }.count }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                summary
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red)
                }
                if !inbox.loaded && inbox.loading {
                    Section {
                        ForEach(0..<3, id: \.self) { _ in
                            placeholderRow.redacted(reason: .placeholder)
                        }
                    }
                }
                if !inbox.agents.isEmpty {
                    Section {
                        ForEach(inbox.agents) { agent in agentCard(agent) }
                    } header: {
                        header("Agents waiting on you", systemImage: "sparkles", color: .orange)
                    }
                }
                if !inbox.proposals.isEmpty {
                    Section {
                        ForEach(inbox.proposals) { p in proposalRow(p) }
                    } header: {
                        header("Additions to approve", systemImage: "plus.square.on.square", color: .purple)
                    }
                }
                if !inbox.shareRequests.isEmpty {
                    Section {
                        ForEach(inbox.shareRequests) { r in shareRow(r) }
                    } header: {
                        header("Share requests", systemImage: "person.2", color: .blue)
                    }
                }
                let groups = Dictionary(grouping: inbox.cards, by: \.column)
                ForEach(["uat", "blocked", "doing", "requests", "must", "nice"], id: \.self) { col in
                    if let cards = groups[col], !cards.isEmpty {
                        Section {
                            ForEach(cards) { card in cardRow(card) }
                        } header: {
                            header(col == "uat" ? "Ready for you to test" : BoardColumn(rawValue: col)?.shortTitle ?? col,
                                   systemImage: BoardColumn(rawValue: col)?.systemImage ?? "circle", color: Theme.columnColor(col))
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
            .background(Color(.systemGroupedBackground))
            .overlay {
                if inbox.loaded && inbox.agents.isEmpty && inbox.proposals.isEmpty && inbox.shareRequests.isEmpty && inbox.cards.isEmpty {
                    ContentUnavailableView {
                        Label("You're all caught up", systemImage: "checkmark.circle")
                    } description: {
                        Text("Agents that need you, approvals, and cards assigned to you show up here.")
                    }
                }
            }
            .navigationTitle("Inbox")
            .toolbar { ToolbarItem(placement: .topBarLeading) { ProfileButton() } }
            .navigationDestination(for: CardRef.self) { ref in CardDetailView(ref: ref) }
            .refreshable { await load() }
            .task { await load() }
            .onChange(of: scenePhase) { if scenePhase == .active { Task { await load() } } }
            .sensoryFeedback(.success, trigger: answered)
            .cardMoveDialog(mover)
            .alert("Reply to \(replyTo?.name ?? "the agent")", isPresented: Binding(get: { replyTo != nil }, set: { if !$0 { replyTo = nil } }), presenting: replyTo) { agent in
                TextField("Your answer", text: $reply)
                Button("Send") { Task { await send(agent, kind: "message", text: reply) } }
                Button("Cancel", role: .cancel) {}
            } message: { agent in
                Text(agent.pending?.summary ?? "")
            }
            .onAppear { mover.onMoved = { _ in answered += 1; Task { await load() } } }
        }
    }

    @ViewBuilder
    private var summary: some View {
        if inbox.loaded {
            VStack(alignment: .leading, spacing: 2) {
                Text(waitingCount == 0 ? "Nothing needs you right now" : waitingCount == 1 ? "1 thing needs you" : "\(waitingCount) things need you")
                    .font(.title3.weight(.semibold))
                let doing = inbox.cards.filter { $0.column == "doing" }.count
                if doing > 0 || !inbox.cards.isEmpty {
                    Text("\(inbox.cards.count) cards assigned to you · \(doing) in progress")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func header(_ title: String, systemImage: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage).foregroundStyle(color)
            Text(title)
        }
        .font(.subheadline.weight(.semibold))
        .textCase(nil)
    }

    private var placeholderRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("A card title that is loading").font(.body.weight(.medium))
            Text("Project · due soon").font(.caption)
        }
        .padding(.vertical, 4)
    }

    private func agentCard(_ agent: WaitingAgent) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: agent.isQuestion ? "questionmark.bubble.fill" : "hand.raised.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(Color.orange.gradient, in: .rect(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(agent.name).font(.headline).lineLimit(1)
                    Text([agent.isQuestion ? "Has a question" : "Wants approval", agent.vendor?.capitalized, agent.host].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            if let summary = agent.pending?.summary, !summary.isEmpty {
                Text(summary)
                    .font(.callout.monospaced())
                    .lineLimit(6)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 10, style: .continuous))
            }
            HStack(spacing: 10) {
                if agent.isQuestion {
                    Button { reply = ""; replyTo = agent } label: {
                        Label("Reply", systemImage: "arrowshape.turn.up.left.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                } else {
                    Button { Task { await send(agent, decision: "deny") } } label: {
                        Text("Deny").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                    Button { Task { await send(agent, decision: "allow") } } label: {
                        Text("Allow").fontWeight(.semibold).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .controlSize(.large)
            .disabled(busy.contains(agent.source + agent.id))
        }
        .padding(.vertical, 6)
    }

    private func proposalRow(_ p: Proposal) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Avatar(name: p.proposedBy, size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(p.proposedBy) added \(summary(p))").font(.subheadline).lineLimit(2)
                    if let env = model.envs.first(where: { $0.id == p.env }) { Text(env.name).font(.caption).foregroundStyle(.secondary) }
                }
            }
            HStack(spacing: 10) {
                Button { Task { await decide(p, approve: false) } } label: { Text("Deny").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).tint(.red)
                Button { Task { await decide(p, approve: true) } } label: { Text("Approve").fontWeight(.semibold).frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
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
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Avatar(name: r.requestedBy, size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(r.requestedBy) wants to share with \(r.toEmail)").font(.subheadline).lineLimit(2)
                    Text("\(r.permission.capitalized) access" + ((r.note ?? "").isEmpty ? "" : " · \(r.note!)")).font(.caption).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 10) {
                Button { Task { await decide(r, approve: false) } } label: { Text("Deny").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).tint(.red)
                Button { Task { await decide(r, approve: true) } } label: { Text("Approve").fontWeight(.semibold).frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
            }
            .disabled(busy.contains(r.id))
        }
        .padding(.vertical, 4)
    }

    private func cardRow(_ card: InboxCard) -> some View {
        NavigationLink(value: CardRef(env: card.env, id: card.id)) {
            VStack(alignment: .leading, spacing: 6) {
                Text(card.title).font(.body.weight(.medium)).lineLimit(2)
                HStack(spacing: 10) {
                    if let p = card.project {
                        ProjectTag(project: FlowProject(id: p.id, name: p.name, color: p.color))
                    }
                    if let due = card.due, !due.isEmpty { DueLabel(due: due) }
                    Text(card.roles.map(\.capitalized).joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Text(card.numberText).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                }
                if model.envs.count > 1, let env = card.envName {
                    Text(env).font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .padding(.vertical, 3)
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if let col = BoardColumn(rawValue: card.column), let next = col.nextStep {
                Button { Task { await advance(card, to: next.to) } } label: { Label(next.title, systemImage: next.systemImage) }
                    .tint(Theme.columnColor(next.to.rawValue))
            }
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            if model.envs.isEmpty { try await model.loadEnvs() }
            try await inbox.load(api, envs: model.envs)
            withAnimation { error = nil }
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            model.handle(error)
            withAnimation { self.error = error.localizedDescription }
        }
    }

    private func advance(_ card: InboxCard, to: BoardColumn) async {
        guard let api = model.api else { return }
        // The full card (for ifUpdated), then the same move as the board.
        guard let full = try? await api.card(env: card.env, card: card.id) else { return }
        await mover.move(api, env: card.env, card: full, to: to, approve: full.column == BoardColumn.uat.rawValue && to == .done)
    }

    private func send(_ agent: WaitingAgent, decision: String? = nil, kind: String? = nil, text: String? = nil) async {
        guard let api = model.api else { return }
        let key = agent.source + agent.id
        busy.insert(key)
        defer { busy.remove(key) }
        do {
            try await api.answer(.init(source: agent.source, agentId: agent.id, requestId: decision == nil ? nil : agent.pending?.requestId,
                                       decision: decision, kind: kind, text: text))
            withAnimation { inbox.remove(agent: agent) }
            answered += 1
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
        do { try await api.decide(env: p.env, proposal: p.id, approve: approve); withAnimation { inbox.remove(proposal: p) }; answered += 1 }
        catch { self.error = error.localizedDescription }
    }

    private func decide(_ r: ShareRequest, approve: Bool) async {
        guard let api = model.api else { return }
        busy.insert(r.id)
        defer { busy.remove(r.id) }
        do { try await api.decide(shareRequest: r.id, approve: approve); withAnimation { inbox.remove(shareRequest: r) }; answered += 1 }
        catch { self.error = error.localizedDescription }
    }
}
