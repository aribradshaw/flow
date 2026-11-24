import Foundation
import Security

// The app's credential, kept in the Keychain (this device only, after first unlock).
enum Keychain {
    private static let service = "flow.credential"
    private static let account = "current"

    static func load() -> Credential? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Credential.self, from: data)
    }

    static func save(_ credential: Credential) {
        guard let data = try? JSONEncoder().encode(credential) else { return }
        delete()
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
        ]
        SecItemAdd(item as CFDictionary, nil)
    }

    // A short id for this install, kept across sign-outs and reinstalls, so a new sign-in can replace
    // this device's earlier key instead of adding another (Flow allows a handful per account).
    static var deviceID: String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "flow.device",
            kSecAttrAccount as String: "id",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data, let id = String(data: data, encoding: .utf8) {
            return id
        }
        let id = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(6)).lowercased()
        SecItemAdd([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "flow.device",
            kSecAttrAccount as String: "id",
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(id.utf8),
        ] as CFDictionary, nil)
        return id
    }

    static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
