import UIKit
import Capacitor

/// HorseDevice.name() → { name }: a label for this phone in sync conflict-copy
/// names. UIDevice.model ("iPhone", "iPad") — no permission needed; the
/// user-set device name needs an entitlement since iOS 16 and is personal.
@objc(HorseDevicePlugin)
public class HorseDevicePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HorseDevicePlugin"
    public let jsName = "HorseDevice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "name", returnType: CAPPluginReturnPromise)
    ]

    @objc func name(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let model = UIDevice.current.model.trimmingCharacters(in: .whitespaces)
            call.resolve(["name": model.isEmpty ? "iPhone" : model])
        }
    }
}
