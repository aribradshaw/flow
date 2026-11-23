import SwiftUI

extension Color {
    // "#2f7d4f" or "2f7d4f"; nil for anything else.
    init?(hex: String?) {
        guard var s = hex?.trimmingCharacters(in: .whitespaces) else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }

    // A Flow color: a hex value or one of the label tokens.
    init(flow value: String?) {
        self = Color(hex: value) ?? Color(hex: LabelTone.of(value).text) ?? .gray
    }
}

// Label color tokens: background and text pairs, the same as public/devops-core.js COLORS.
struct LabelTone {
    let background: String
    let text: String

    static func of(_ key: String?) -> LabelTone {
        tones[key ?? ""] ?? LabelTone(background: "#e8e9eb", text: "#3f4247")
    }

    private static let tones: [String: LabelTone] = [
        "red": .init(background: "#fdd5d2", text: "#8e1f17"), "orange": .init(background: "#ffe2bd", text: "#7a3d00"),
        "yellow": .init(background: "#fff0a8", text: "#614b00"), "green": .init(background: "#cce9d7", text: "#145c32"),
        "blue": .init(background: "#cfe4ff", text: "#174f91"), "sky": .init(background: "#cdeef6", text: "#145866"),
        "purple": .init(background: "#e6dcff", text: "#513595"), "pink": .init(background: "#f8d6e9", text: "#7a2854"),
        "lime": .init(background: "#e1efb5", text: "#415c08"), "black": .init(background: "#d8dadd", text: "#242629"),
        "teal": .init(background: "#c7ebe4", text: "#0f5c52"), "indigo": .init(background: "#d7dbf7", text: "#2f3d8f"),
        "rose": .init(background: "#fad4dc", text: "#8a2340"), "amber": .init(background: "#fce8b8", text: "#6b4a00"),
        "brown": .init(background: "#ead9c8", text: "#5c3a1e"), "slate": .init(background: "#d7dde5", text: "#2f3a4a"),
        "red-deep": .init(background: "#f5b8b4", text: "#6e120c"),
    ]
}

// A label as the web draws it: a pastel pill with dark text.
struct LabelChip: View {
    let label: FlowLabel

    var body: some View {
        let tone = LabelTone.of(label.color)
        Text(label.name)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(Color(hex: tone.text) ?? .primary)
            .background(Color(hex: label.color) ?? Color(hex: tone.background) ?? .gray.opacity(0.2), in: .capsule)
    }
}
