import SwiftUI

// Creating a card, or editing one: title, description, project, labels, points, due date, checklist, links.
// An edit sends only what changed, with ifUpdated, so a change someone made meanwhile is reported, not lost.
struct CardEditorView: View {
    enum Mode {
        case create(env: String, column: BoardColumn, project: String?)
        case edit(env: String, card: FlowCard)
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let mode: Mode
    let onSave: (FlowCard) -> Void

    @State private var meta = AppModel.EnvMeta()
    @State private var title = ""
    @State private var text = ""
    @State private var project: String?
    @State private var labels: Set<String> = []
    @State private var points = ""
    @State private var hasDue = false
    @State private var due = Date()
    @State private var checklist: [CardPatch.ChecklistEdit] = []
    @State private var newItem = ""
    @State private var links: [CardPatch.LinkEdit] = []
    @State private var newLink = ""
    @State private var column: BoardColumn = .requests
    @State private var saving = false
    @State private var error: String?
    @State private var loaded = false

    private var env: String {
        switch mode {
        case .create(let env, _, _), .edit(let env, _): env
        }
    }

    private var original: FlowCard? {
        if case .edit(_, let card) = mode { card } else { nil }
    }

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let error {
                        Label(error, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(Theme.danger)
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        TextField("Card title", text: $title, axis: .vertical)
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(Theme.ink)
                            .padding(12)
                        Rectangle().fill(Theme.line).frame(height: 1)
                        TextField("Add a description (Markdown works)", text: $text, axis: .vertical)
                            .font(.subheadline)
                            .foregroundStyle(Theme.ink)
                            .lineLimit(4...14)
                            .padding(12)
                    }
                    .background(Theme.surface, in: .rect(cornerRadius: Theme.panelCorner))
                    .overlay(RoundedRectangle(cornerRadius: Theme.panelCorner).strokeBorder(Theme.line))

                    FlowGroup(title: "Details") {
                        if original == nil {
                            FlowRow(icon: "rectangle.split.3x1", title: "Column") {
                                ValueMenu(value: column.shortTitle, color: Theme.columnColor(column.rawValue)) {
                                    Picker("Column", selection: $column) {
                                        ForEach(BoardColumn.allCases) { Text($0.title).tag($0) }
                                    }
                                }
                            }
                        }
                        FlowRow(icon: "folder", title: "Project") {
                            let p = project.flatMap { meta.projects[$0] }
                            ValueMenu(value: p?.name ?? "None", color: p.map { Color(flow: $0.color) }) {
                                Picker("Project", selection: $project) {
                                    Text("None").tag(String?.none)
                                    ForEach(meta.sortedProjects) { Text($0.name).tag(Optional($0.id)) }
                                }
                            }
                        }
                        NavigationLink {
                            LabelPicker(labels: meta.sortedLabels, selected: $labels)
                        } label: {
                            FlowRow(icon: "tag", title: "Labels") {
                                let chosen = meta.sortedLabels.filter { labels.contains($0.id) }
                                if chosen.isEmpty { Text("None").font(.subheadline).foregroundStyle(Theme.muted) }
                                else { HStack(spacing: 4) { ForEach(chosen.prefix(3)) { LabelChip(label: $0) } } }
                                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint)
                            }
                        }
                        .buttonStyle(.plain)
                        FlowRow(icon: "gauge.with.needle", title: "Points") {
                            TextField("–", text: $points)
                                .keyboardType(.decimalPad)
                                .multilineTextAlignment(.trailing)
                                .font(.subheadline)
                                .foregroundStyle(Theme.ink)
                                .frame(maxWidth: 80)
                        }
                        FlowRow(icon: "calendar", title: "Due") {
                            if hasDue {
                                DatePicker("Due", selection: $due, displayedComponents: .date).labelsHidden()
                                Button { withAnimation { hasDue = false } } label: {
                                    Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.faint)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Remove the due date")
                            } else {
                                Button("Add a date") { withAnimation { hasDue = true } }
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(Theme.accent)
                            }
                        }
                    }

                    FlowGroup(title: checklist.isEmpty ? "Checklist" : "Checklist · \(checklist.filter(\.done).count) of \(checklist.count)") {
                        ForEach($checklist, id: \.localID) { $item in
                            HStack(spacing: 10) {
                                Button { item.done.toggle() } label: { FlowCheckbox(done: item.done) }
                                    .buttonStyle(.plain)
                                TextField("Item", text: $item.text, axis: .vertical)
                                    .font(.subheadline)
                                    .foregroundStyle(item.done ? Theme.muted : Theme.ink)
                                Button { checklist.removeAll { $0.localID == item.localID } } label: {
                                    Image(systemName: "minus.circle").foregroundStyle(Theme.faint)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Remove this item")
                            }
                            .padding(.horizontal, 12)
                            .frame(minHeight: 44)
                        }
                        HStack(spacing: 10) {
                            Image(systemName: "plus").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accent).frame(width: 18)
                            TextField("Add an item", text: $newItem)
                                .font(.subheadline)
                                .onSubmit(addItem)
                                .submitLabel(.done)
                        }
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                    }

                    FlowGroup(title: "Links") {
                        ForEach(links, id: \.self) { link in
                            HStack(spacing: 10) {
                                Image(systemName: link.kind == "pr" ? "arrow.triangle.pull" : link.kind == "commit" ? "smallcircle.filled.circle" : "link")
                                    .foregroundStyle(Theme.accent).frame(width: 18)
                                VStack(alignment: .leading, spacing: 1) {
                                    if let url = URL(string: link.url) {
                                        Text(LinkInfo(url).title).font(.subheadline).foregroundStyle(Theme.ink).lineLimit(1)
                                        Text(LinkInfo(url).subtitle).font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                                    } else {
                                        Text(link.url).font(.subheadline).lineLimit(1)
                                    }
                                }
                                Spacer()
                                Button { links.removeAll { $0 == link } } label: { Image(systemName: "minus.circle").foregroundStyle(Theme.faint) }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Remove this link")
                            }
                            .padding(.horizontal, 12)
                            .frame(minHeight: 48)
                        }
                        HStack(spacing: 10) {
                            Image(systemName: "plus").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accent).frame(width: 18)
                            TextField("Paste a link", text: $newLink)
                                .font(.subheadline)
                                .keyboardType(.URL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .onSubmit(addLink)
                                .submitLabel(.done)
                        }
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                    }
                }
                .padding()
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            .tint(Theme.accent)
            .navigationTitle(original.map { "Edit \($0.numberText)" } ?? "New card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(original == nil ? "Add" : "Save") { Task { await save() } }
                        .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || saving)
                }
            }
            .disabled(saving)
            .task {
                guard !loaded else { return }
                loaded = true
                meta = await model.meta(env)
                fill()
            }
        }
    }

    private func fill() {
        switch mode {
        case .create(_, let col, let proj):
            column = col
            project = proj
        case .edit(_, let card):
            title = card.title
            text = card.description ?? ""
            project = card.project?.isEmpty == false ? card.project : nil
            labels = Set(card.labels ?? [])
            points = card.points.map { $0.formatted() } ?? ""
            if let d = card.due, let date = Self.day.date(from: d) { hasDue = true; due = date }
            checklist = (card.checklist ?? []).map { .init(id: $0.id, text: $0.text, done: $0.done) }
            links = (card.links ?? []).map { .init(id: $0.id, kind: $0.kind, url: $0.url) }
        }
    }

    private func addItem() {
        let t = newItem.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        checklist.append(.init(id: nil, text: t, done: false))
        newItem = ""
    }

    private func addLink() {
        let t = newLink.trimmingCharacters(in: .whitespaces)
        guard URL(string: t)?.scheme?.hasPrefix("http") == true else { return }
        let kind = t.contains("/pull/") ? "pr" : t.contains("/commit/") ? "commit" : "url"
        links.append(.init(id: nil, kind: kind, url: t))
        newLink = ""
    }

    private var pointsValue: Double?? {
        let t = points.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        if t.isEmpty { return .some(nil) }
        return Double(t).map { .some($0) }
    }

    // Only what differs from the card as it was opened.
    private func patch(from card: FlowCard) -> CardPatch {
        var p = CardPatch(ifUpdated: card.updated)
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if t != card.title { p.title = t }
        if text != (card.description ?? "") { p.description = text }
        if (project ?? "") != (card.project ?? "") { p.project = project ?? "" }
        if labels != Set(card.labels ?? []) { p.labels = meta.sortedLabels.map(\.id).filter(labels.contains) + labels.filter { meta.labels[$0] == nil } }
        if let v = pointsValue, v != card.points { p.points = .some(v) }
        let d = hasDue ? Self.day.string(from: due) : ""
        if d != (card.due ?? "") { p.due = d }
        let was = (card.checklist ?? []).map { CardPatch.ChecklistEdit(id: $0.id, text: $0.text, done: $0.done) }
        let now = checklist.filter { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }
        if now != was { p.checklist = now }
        let oldLinks = (card.links ?? []).map { CardPatch.LinkEdit(id: $0.id, kind: $0.kind, url: $0.url) }
        if links != oldLinks { p.links = links }
        return p
    }

    private func save() async {
        guard let api = model.api else { return }
        if pointsValue == nil { error = "Points must be a number."; return }
        saving = true
        defer { saving = false }
        do {
            switch mode {
            case .create(let env, _, _):
                var made = try await api.createCard(env: env, NewCard(title: title.trimmingCharacters(in: .whitespacesAndNewlines), column: column.rawValue,
                                                                      project: project, description: text.isEmpty ? nil : text))
                // Everything else goes on in a second step, so the create stays a plain one.
                var rest = patch(from: made)
                rest.title = nil; rest.description = nil; rest.project = nil
                if !rest.isEmpty { made = try await api.updateCard(env: env, card: made.id, rest) }
                onSave(made)
            case .edit(let env, let card):
                let p = patch(from: card)
                if !p.isEmpty { onSave(try await api.updateCard(env: env, card: card.id, p)) }
            }
            dismiss()
        } catch let e as FlowError where e.code == "card_changed" {
            error = "Someone changed this card while you were editing, so your changes weren't saved. Cancel, then reopen the card to see the latest."
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }
}

private struct LabelPicker: View {
    let labels: [FlowLabel]
    @Binding var selected: Set<String>

    var body: some View {
        ScrollView {
            FlowGroup {
                ForEach(labels) { label in
                    Button {
                        if selected.contains(label.id) { selected.remove(label.id) } else { selected.insert(label.id) }
                    } label: {
                        HStack {
                            LabelChip(label: label)
                            Spacer()
                            FlowCheckbox(done: selected.contains(label.id))
                        }
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding()
        }
        .background(Theme.bg)
        .navigationTitle("Labels")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.selection, trigger: selected)
    }
}
