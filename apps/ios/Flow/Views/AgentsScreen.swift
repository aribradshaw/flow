import SwiftUI
import WidgetKit

// Your agents, live: what the 3D office shows, made for a phone and a tablet. Each agent is a desk with
// its mascot and a status ring (turning while it works, pulsing while it waits on you), what it is doing
// this moment (its latest reasoning or tool step) and its subagents. Waiting agents can be answered right
// on the desk; a desk opens to its live steps, recent conversation, Message and Stop.

@MainActor
@Observable
final class AgentsStore {
    static let shared = AgentsStore()

    private(set) var agents: [LiveAgent] = []
    private(set) var loaded = false
    var error: String?

    var waiting: Int { agents.filter { $0.state == .waiting }.count }
    var working: Int { agents.filter { $0.state == .working }.count }
    var idle: Int { agents.filter { $0.state == .idle }.count }

    // By machine, the busiest machines first; on each, waiting agents first, then working, then idle.
    var machines: [(name: String, agents: [LiveAgent])] {
        Dictionary(grouping: agents, by: \.machine)
            .map { (name: $0.key, agents: $0.value.sorted { ($0.state, $0.name) < ($1.state, $1.name) }) }
            .sorted { ($0.agents.first?.state ?? .idle, $0.name) < ($1.agents.first?.state ?? .idle, $1.name) }
    }

    func refresh(_ api: FlowAPI) async {
        do {
            let fresh = try await api.liveAgents()
            if fresh != agents { withAnimation(.snappy) { agents = fresh } }
            loaded = true
            error = nil
            writeSnapshot()
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            self.error = error.localizedDescription
        }
    }

    func forget(_ agent: LiveAgent) { withAnimation(.snappy) { agents.removeAll { $0.id == agent.id && $0.source == agent.source } } }

    // The widgets' copy (Shared/WidgetSnapshot.swift).
    private func writeSnapshot() {
        var s = SharedStore.load()
        s.live = agents.sorted { ($0.state, $0.name) < ($1.state, $1.name) }.prefix(6).map {
            .init(id: ($0.source ?? "") + $0.id, name: $0.name, doing: $0.activity ?? "", state: $0.status ?? "idle", vendor: $0.vendor ?? "other")
        }
        s.liveWorking = working
        s.liveWaiting = waiting
        s.signedIn = true
        s.updated = .now
        SharedStore.save(s)
        WidgetCenter.shared.reloadTimelines(ofKind: "FlowAgents")
    }
}

// MARK: The tab

struct AgentsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var store = AgentsStore.shared
    @State private var open: LiveAgent?
    @State private var replyTo: LiveAgent?
    @State private var reply = ""
    @State private var answered = 0

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if store.loaded && store.agents.isEmpty {
                        empty
                    } else {
                        summary
                        if let error = store.error {
                            Label(error, systemImage: "wifi.exclamationmark").font(.footnote).foregroundStyle(Theme.danger)
                        }
                        ForEach(store.machines, id: \.name) { machine in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(spacing: 6) {
                                    Image(systemName: "laptopcomputer").font(.caption)
                                    Text(machine.name)
                                    Text("\(machine.agents.count)").foregroundStyle(Theme.faint)
                                }
                                .flowSectionTitle()
                                LazyVGrid(columns: [GridItem(.adaptive(minimum: sizeClass == .regular ? 330 : 280), spacing: 12)], spacing: 12) {
                                    ForEach(machine.agents) { agent in
                                        AgentDesk(agent: agent, onAnswer: { answer(agent, $0) }, onReply: { reply = ""; replyTo = agent })
                                            .onTapGesture { open = agent }
                                    }
                                }
                            }
                        }
                        if !store.loaded {
                            ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                        }
                    }
                }
                .padding()
                .frame(maxWidth: 1100)
                .frame(maxWidth: .infinity)
            }
            .background(Theme.bg)
            .navigationTitle("Agents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { ProfileButton() } }
            .refreshable { if let api = model.api { await store.refresh(api) } }
            .task {
                // Live while this tab is on screen: every 3 seconds.
                #if DEBUG
                // UI testing: `-openAgent YES` opens the first agent.
                if UserDefaults.standard.bool(forKey: "openAgent"), let api = model.api {
                    await store.refresh(api)
                    open = store.machines.first?.agents.first(where: { $0.state == .working })
                }
                #endif
                while !Task.isCancelled {
                    if let api = model.api { await store.refresh(api) }
                    try? await Task.sleep(for: .seconds(3))
                }
            }
            .sheet(item: $open) { agent in
                AgentSheet(agentID: agent.id, source: agent.source)
            }
            .alert("Reply to \(replyTo?.name ?? "the agent")", isPresented: Binding(get: { replyTo != nil }, set: { if !$0 { replyTo = nil } }), presenting: replyTo) { agent in
                TextField("Your answer", text: $reply)
                Button("Send") { send(agent, kind: "message", text: reply) }
                Button("Cancel", role: .cancel) {}
            } message: { agent in
                Text(agent.pending?.summary ?? "")
            }
            .sensoryFeedback(.success, trigger: answered)
        }
    }

    private var summary: some View {
        HStack(spacing: 0) {
            stat(store.working, "Working", Theme.green)
            Rectangle().fill(Theme.line).frame(width: 1, height: 34)
            stat(store.waiting, "Waiting on you", Theme.brick)
            Rectangle().fill(Theme.line).frame(width: 1, height: 34)
            stat(store.idle, "Idle", Theme.faint)
        }
        .padding(.vertical, 12)
        .background(Theme.surface, in: .rect(cornerRadius: Theme.panelCorner))
        .overlay(RoundedRectangle(cornerRadius: Theme.panelCorner).strokeBorder(Theme.line))
    }

    private func stat(_ n: Int, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 3) {
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 7, height: 7)
                Text("\(n)").font(.title3.weight(.semibold).monospacedDigit()).foregroundStyle(Theme.ink).contentTransition(.numericText())
            }
            Text(label).font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }

    private var empty: some View {
        VStack(spacing: 14) {
            Mascot(vendor: "claude", state: .idle, size: 64)
            Text("No agents running").font(.headline).foregroundStyle(Theme.ink)
            Text("When Claude, Codex or another agent works on your computer with the Flow office bridge, it shows up here live: what it's doing, and anything it needs from you.")
                .font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity)
        .padding(.top, 80)
    }

    private func answer(_ agent: LiveAgent, _ decision: String) {
        guard let api = model.api, let source = agent.source else { return }
        Task {
            try? await api.answer(.init(source: source, agentId: agent.id, requestId: agent.pending?.requestId, decision: decision))
            answered += 1
            await store.refresh(api)
        }
    }

    private func send(_ agent: LiveAgent, kind: String, text: String? = nil) {
        guard let api = model.api, let source = agent.source else { return }
        Task {
            try? await api.answer(.init(source: source, agentId: agent.id, kind: kind, text: text))
            answered += 1
            await store.refresh(api)
        }
    }
}

// MARK: A desk

struct AgentDesk: View {
    let agent: LiveAgent
    var onAnswer: (String) -> Void = { _ in }
    var onReply: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Mascot(vendor: agent.vendor, state: agent.state, size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.name).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(2)
                    Text([agent.model, agent.role == "conductor" ? "Chief of Staff" : nil].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 4)
                StateTag(state: agent.state, question: agent.isQuestion)
            }

            if agent.state == .waiting, let summary = agent.pending?.summary, !summary.isEmpty {
                Text(summary)
                    .font(.footnote.monospaced())
                    .foregroundStyle(Theme.ink)
                    .lineLimit(4)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.bg, in: .rect(cornerRadius: Theme.corner))
                    .overlay(RoundedRectangle(cornerRadius: Theme.corner).strokeBorder(Theme.line))
                HStack(spacing: 8) {
                    if agent.isQuestion || !agent.canAnswer {
                        Button("Reply", action: onReply).buttonStyle(.flow(.primary)).frame(maxWidth: .infinity)
                    } else {
                        Button { onAnswer("deny") } label: { Text("Deny").padding(.horizontal, 8) }.buttonStyle(.flow(.secondary))
                        Button { onAnswer("allow") } label: { Text("Allow").frame(maxWidth: .infinity) }.buttonStyle(.flow(.primary))
                    }
                }
            } else if agent.state != .idle || agent.activity?.isEmpty == false {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    ActivityIcon(kind: agent.activityKind, active: agent.state == .working)
                    Text(agent.activity?.isEmpty == false ? agent.activity! : agent.state == .idle ? "Idle" : "Thinking")
                        .font(.subheadline)
                        .foregroundStyle(agent.state == .idle ? Theme.muted : Theme.ink)
                        .lineLimit(2)
                        .contentTransition(.opacity)
                }
                if agent.state == .working, let line = liveLine {
                    HStack(spacing: 6) {
                        Image(systemName: phaseSymbol(agent.live?.phase)).font(.caption2).foregroundStyle(Theme.accent)
                        Text(line)
                            .font(.caption.monospaced())
                            .foregroundStyle(Theme.muted)
                            .lineLimit(2)
                            .contentTransition(.opacity)
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.bg, in: .rect(cornerRadius: Theme.corner))
                    .id(line)
                    .transition(.opacity)
                }
            }

            if let kids = agent.children, !kids.isEmpty {
                HStack(spacing: 6) {
                    ForEach(Array(kids.prefix(8).enumerated()), id: \.offset) { _, c in
                        Mascot(vendor: c.vendor ?? agent.vendor, state: state(c.status), size: 18, ring: false)
                    }
                    Text(kids.count == 1 ? "1 subagent" : "\(kids.count) subagents").font(.caption).foregroundStyle(Theme.muted)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: .rect(cornerRadius: Theme.panelCorner))
        .overlay(RoundedRectangle(cornerRadius: Theme.panelCorner).strokeBorder(agent.state == .waiting ? Theme.brick.opacity(0.55) : Theme.line))
        .contentShape(.rect)
    }

    private var liveLine: String? {
        if let step = agent.live?.steps?.last?.text, !step.isEmpty { return step }
        if let t = agent.live?.text, !t.isEmpty { return t.replacingOccurrences(of: "\n", with: " ") }
        return nil
    }

    private func state(_ s: String?) -> LiveAgent.State { s == "waiting" ? .waiting : s == "running" ? .working : .idle }
}

func phaseSymbol(_ phase: String?) -> String {
    switch phase {
    case "tool": "wrench.and.screwdriver"
    case "writing": "text.cursor"
    default: "sparkle"
    }
}

struct StateTag: View {
    let state: LiveAgent.State
    var question = false

    var body: some View {
        switch state {
        case .waiting: Tag(text: question ? "Question" : "Needs you", color: Theme.brick)
        case .working: Tag(text: "Working", color: Theme.accent)
        case .idle: Tag(text: "Idle", color: Theme.faint)
        }
    }
}

// The agent's mascot: its vendor's color and mark, inside a ring that turns while it works and pulses
// while it waits on you.
struct Mascot: View {
    let vendor: String?
    let state: LiveAgent.State
    var size: CGFloat = 40
    var ring = true

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(Mascot.color(vendor).gradient)
                .frame(width: size * 0.78, height: size * 0.78)
            Image(systemName: Mascot.mark(vendor))
                .font(.system(size: size * 0.34, weight: .semibold))
                .foregroundStyle(.white)
            if ring { StatusRing(state: state, size: size) }
        }
        .frame(width: size, height: size)
        .opacity(state == .idle && !ring ? 0.55 : 1)
    }

    static func color(_ vendor: String?) -> Color {
        switch vendor?.lowercased() {
        case "claude": Color(hex: "#d97757")!
        case "codex": Color(hex: "#2b2f33")!
        case "gemini": Color(hex: "#4b7be5")!
        case "deepseek": Color(hex: "#4d6bfe")!
        case "grok": Color(hex: "#5a5f66")!
        default: Color(hex: "#324b34")!
        }
    }

    static func mark(_ vendor: String?) -> String {
        switch vendor?.lowercased() {
        case "claude": "asterisk"
        case "codex": "chevron.left.forwardslash.chevron.right"
        case "gemini": "sparkle"
        case "deepseek": "water.waves"
        case "grok": "bolt.fill"
        default: "cpu"
        }
    }
}

struct StatusRing: View {
    let state: LiveAgent.State
    let size: CGFloat

    var body: some View {
        switch state {
        case .working:
            TimelineView(.animation) { t in
                let angle = t.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6 * 360
                Circle()
                    .trim(from: 0, to: 0.32)
                    .stroke(Theme.green, style: StrokeStyle(lineWidth: max(2, size * 0.06), lineCap: .round))
                    .rotationEffect(.degrees(angle))
                    .background(Circle().stroke(Theme.green.opacity(0.18), lineWidth: max(2, size * 0.06)))
            }
        case .waiting:
            PhaseAnimator([0.35, 1.0]) { phase in
                Circle().stroke(Theme.brick.opacity(phase), lineWidth: max(2, size * 0.06))
                    .scaleEffect(1 + (1 - phase) * 0.06)
            } animation: { _ in .easeInOut(duration: 0.9) }
        case .idle:
            Circle().stroke(Theme.line2, lineWidth: max(1.5, size * 0.04))
        }
    }
}

struct ActivityIcon: View {
    let kind: String?
    let active: Bool

    var body: some View {
        Image(systemName: symbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(active ? Theme.accent : Theme.faint)
            .symbolEffect(.pulse, isActive: active)
            .frame(width: 16)
    }

    private var symbol: String {
        switch kind {
        case "edit": "pencil"
        case "read": "doc.text"
        case "search": "magnifyingglass"
        case "run": "terminal"
        case "test": "checkmark.circle"
        case "web": "globe"
        case "think": "brain"
        default: "circle.dotted"
        }
    }
}

// MARK: One agent, opened

struct AgentSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let agentID: String
    let source: String?
    @State private var store = AgentsStore.shared
    @State private var message = ""
    @State private var sent = 0
    @State private var confirmStop = false

    private var agent: LiveAgent? { store.agents.first { $0.id == agentID && $0.source == source } }

    var body: some View {
        NavigationStack {
            ScrollView {
                if let agent {
                    VStack(alignment: .leading, spacing: 18) {
                        HStack(spacing: 14) {
                            Mascot(vendor: agent.vendor, state: agent.state, size: 64)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(agent.name).font(.title3.weight(.semibold)).foregroundStyle(Theme.ink)
                                Text([agent.model, agent.machine].compactMap { $0 }.joined(separator: " · ")).font(.subheadline).foregroundStyle(Theme.muted)
                                StateTag(state: agent.state, question: agent.isQuestion)
                            }
                        }
                        if agent.state == .waiting, let summary = agent.pending?.summary {
                            FlowGroup(title: agent.isQuestion ? "It asks" : "It wants to") {
                                Text(summary).font(.footnote.monospaced()).foregroundStyle(Theme.ink).padding(12)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if agent.canAnswer && !agent.isQuestion {
                                HStack(spacing: 8) {
                                    Button { answer(agent, "deny") } label: { Text("Deny").padding(.horizontal, 10) }.buttonStyle(.flow(.secondary, large: true))
                                    Button { answer(agent, "allow") } label: { Text("Allow") }.buttonStyle(.flow(.primary, large: true))
                                }
                            }
                        } else {
                            FlowGroup(title: "Now") {
                                HStack(spacing: 10) {
                                    ActivityIcon(kind: agent.activityKind, active: agent.state == .working)
                                    Text(agent.activity ?? (agent.state == .idle ? "Idle" : "Thinking")).font(.subheadline).foregroundStyle(Theme.ink)
                                    Spacer()
                                }
                                .padding(12)
                            }
                        }
                        if let steps = agent.live?.steps, !steps.isEmpty {
                            FlowGroup(title: "Live") {
                                ForEach(Array(steps.reversed().enumerated()), id: \.offset) { i, step in
                                    HStack(alignment: .top, spacing: 10) {
                                        Image(systemName: phaseSymbol(step.kind)).font(.caption).foregroundStyle(i == 0 ? Theme.accent : Theme.faint).frame(width: 16)
                                        Text(step.text).font(.caption.monospaced()).foregroundStyle(i == 0 ? Theme.ink : Theme.muted).lineLimit(3)
                                        Spacer(minLength: 0)
                                    }
                                    .padding(10)
                                }
                            }
                        }
                        if let kids = agent.children, !kids.isEmpty {
                            FlowGroup(title: "Subagents") {
                                ForEach(Array(kids.enumerated()), id: \.offset) { _, c in
                                    HStack(spacing: 10) {
                                        Mascot(vendor: c.vendor ?? agent.vendor, state: c.status == "running" ? .working : c.status == "waiting" ? .waiting : .idle, size: 26)
                                        Text(c.title ?? c.model ?? "Subagent").font(.subheadline).foregroundStyle(Theme.ink).lineLimit(1)
                                        Spacer()
                                    }
                                    .padding(10)
                                }
                            }
                        }
                        if let lines = agent.transcript, !lines.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Conversation").flowSectionTitle()
                                ForEach(Array(lines.suffix(8).enumerated()), id: \.offset) { _, line in bubble(line) }
                            }
                        }
                    }
                    .padding()
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
                } else {
                    ContentUnavailableView("This agent stopped reporting", systemImage: "moon.zzz",
                                           description: Text("It finished, or its computer went to sleep."))
                        .padding(.top, 60)
                }
            }
            .background(Theme.bg)
            .safeAreaInset(edge: .bottom) {
                if let agent, (agent.can ?? []).contains("message") || (agent.can ?? []).contains("stop") {
                    VStack(spacing: 8) {
                        if (agent.can ?? []).contains("message") {
                            HStack(spacing: 8) {
                                TextField("Message \(agent.name)", text: $message, axis: .vertical)
                                    .font(.subheadline)
                                    .lineLimit(1...4)
                                    .padding(10)
                                    .background(Theme.surface, in: .rect(cornerRadius: Theme.corner))
                                    .overlay(RoundedRectangle(cornerRadius: Theme.corner).strokeBorder(Theme.line2))
                                Button { send(agent, kind: "message", text: message); message = "" } label: {
                                    Image(systemName: "arrow.up").font(.subheadline.weight(.bold))
                                }
                                .buttonStyle(.flow(.primary))
                                .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                        }
                        if (agent.can ?? []).contains("stop") && agent.state == .working {
                            Button { confirmStop = true } label: { Label("Stop this turn", systemImage: "stop.fill").frame(maxWidth: .infinity) }
                                .buttonStyle(.flow(.danger))
                        }
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 10)
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
                    .background(Theme.bg.opacity(0.97))
                    .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sensoryFeedback(.success, trigger: sent)
            .confirmationDialog("Stop what it's doing now?", isPresented: $confirmStop, titleVisibility: .visible) {
                Button("Stop", role: .destructive) { if let agent { send(agent, kind: "stop") } }
            } message: {
                Text("It stops its current turn. You can message it to carry on.")
            }
            .task {
                while !Task.isCancelled {
                    if let api = model.api { await store.refresh(api) }
                    try? await Task.sleep(for: .seconds(2))
                }
            }
        }
        .presentationDetents([.large])
    }

    private func bubble(_ line: LiveAgent.Line) -> some View {
        let mine = line.role == "user"
        return HStack {
            if mine { Spacer(minLength: 40) }
            Text(line.text)
                .font(line.role == "tool" ? .caption.monospaced() : .subheadline)
                .foregroundStyle(mine ? .white : line.role == "tool" ? Theme.muted : Theme.ink)
                .lineLimit(line.role == "tool" ? 3 : 12)
                .padding(10)
                .background(mine ? Theme.accent : line.role == "tool" ? Theme.bg : Theme.surface, in: .rect(cornerRadius: Theme.panelCorner))
                .overlay { if !mine { RoundedRectangle(cornerRadius: Theme.panelCorner).strokeBorder(Theme.line) } }
            if !mine { Spacer(minLength: 40) }
        }
    }

    private func answer(_ agent: LiveAgent, _ decision: String) {
        guard let api = model.api, let source = agent.source else { return }
        Task { try? await api.answer(.init(source: source, agentId: agent.id, requestId: agent.pending?.requestId, decision: decision)); sent += 1; await store.refresh(api) }
    }

    private func send(_ agent: LiveAgent, kind: String, text: String? = nil) {
        guard let api = model.api, let source = agent.source else { return }
        Task { try? await api.answer(.init(source: source, agentId: agent.id, kind: kind, text: text)); sent += 1; await store.refresh(api) }
    }
}
