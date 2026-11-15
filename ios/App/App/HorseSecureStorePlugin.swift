import Foundation
import Security
import Capacitor

/// HorseSecureStore: cloud-sync credentials (WebDAV passwords, S3 secret keys).
///
/// get({ key }) → { value: string | null }, set({ key, value }), remove({ key }),
/// keys({ prefix }) → { keys: [] }.
///
/// Keychain generic passwords, service "com.horsemd.app.sync", account = key,
/// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: readable in the
/// background after the first unlock (sync on resume), never synced to iCloud
/// Keychain and never restored onto another device from a backup. Note that
/// Keychain items outlive an uninstall of the app.
@objc(HorseSecureStorePlugin)
public class HorseSecureStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HorseSecureStorePlugin"
    public let jsName = "HorseSecureStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keys", returnType: CAPPluginReturnPromise)
    ]

    private static let service = "com.horsemd.app.sync"

    private func baseQuery(_ key: String? = nil) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service
        ]
        if let key = key { q[kSecAttrAccount as String] = key }
        return q
    }

    private func requireKey(_ call: CAPPluginCall) -> String? {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("A key is required", "EINVAL")
            return nil
        }
        return key
    }

    private func rejectStatus(_ call: CAPPluginCall, _ status: OSStatus) {
        call.reject("Keychain error \(status)", "SECURE_STORE")
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = requireKey(call) else { return }
        var q = baseQuery(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
            return
        }
        guard status == errSecSuccess, let data = item as? Data else {
            rejectStatus(call, status)
            return
        }
        if let text = String(data: data, encoding: .utf8) {
            call.resolve(["value": text])
        } else {
            call.resolve(["value": NSNull()])
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = requireKey(call) else { return }
        guard let value = call.getString("value") else {
            call.reject("A string value is required", "EINVAL")
            return
        }
        let data = Data(value.utf8)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(baseQuery(key) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery(key)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            rejectStatus(call, status)
            return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = requireKey(call) else { return }
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            rejectStatus(call, status)
            return
        }
        call.resolve()
    }

    @objc func keys(_ call: CAPPluginCall) {
        let prefix = call.getString("prefix") ?? ""
        var q = baseQuery()
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var items: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &items)
        if status == errSecItemNotFound {
            call.resolve(["keys": [String]()])
            return
        }
        guard status == errSecSuccess, let list = items as? [[String: Any]] else {
            rejectStatus(call, status)
            return
        }
        let keys = list
            .compactMap { $0[kSecAttrAccount as String] as? String }
            .filter { $0.hasPrefix(prefix) }
            .sorted()
        call.resolve(["keys": keys])
    }
}
