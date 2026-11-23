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
            Form {
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                }
                Section {
                    TextField("Title", text: $title, axis: .vertical)
                        .font(.headline)
                    TextField("Description", text: $text, axis: .vertical)
                        .lineLimit(3...12)
                }
                Section {
                    if original == nil {
                        Picker("Column", selection: $column) {
                            ForEach(BoardColumn.allCases) { Text($0.title).tag($0) }
                        }
                    }
                    Picker("Project", selection: $project) {
                        Text("None").tag(String?.none)
                        ForEach(meta.sortedProjects) { Text($0.name).tag(Optional($0.id)) }
                    }
                    NavigationLink {
                        LabelPicker(labels: meta.sortedLabels, selected: $labels)
                    } label: {
                        LabeledContent("Labels", value: labels.isEmpty ? "None" : meta.sortedLabels.filter { labels.contains($0.id) }.map(\.name).joined(separator: ", "))
                    }
                    TextField("Points", text: $points)
                        .keyboardType(.decimalPad)
                    Toggle("Due date", isOn: $hasDue.animation())
                    if hasDue {
                        DatePicker("Due", selection: $due, displayedComponents: .date)
                    }
                }
                Section("Checklist") {
                    ForEach($checklist, id: \.localID) { $item in
                        HStack {
                            Button {
                                item.done.toggle()
                            } label: {
                                Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                            }
                            .buttonStyle(.plain)
                            TextField("Item", text: $item.text)
                        }
                    }
                    .onDelete { checklist.remove(atOffsets: $0) }
                    .onMove { checklist.move(fromOffsets: $0, toOffset: $1) }
                    HStack {
                        TextField("Add an item", text: $newItem)
                            .onSubmit(addItem)
                        Button("Add", systemImage: "plus.circle.fill", action: addItem)
                            .labelStyle(.iconOnly)
                            .disabled(newItem.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                Section("Links") {
                    ForEach(links, id: \.self) { link in
                        Text(link.url).lineLimit(1).font(.callout)
                    }
                    .onDelete { links.remove(atOffsets: $0) }
                    HStack {
                        TextField("https://…", text: $newLink)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onSubmit(addLink)
                        Button("Add", systemImage: "plus.circle.fill", action: addLink)
                            .labelStyle(.iconOnly)
                            .disabled(URL(string: newLink)?.scheme?.hasPrefix("http") != true)
                    }
                }
            }
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
        List(labels) { label in
            Button {
                if selected.contains(label.id) { selected.remove(label.id) } else { selected.insert(label.id) }
            } label: {
                HStack {
                    LabelChip(label: label)
                    Spacer()
                    if selected.contains(label.id) { Image(systemName: "checkmark").foregroundStyle(.tint) }
                }
            }
            .buttonStyle(.plain)
        }
        .navigationTitle("Labels")
    }
}
