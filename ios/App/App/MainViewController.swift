import UIKit
import Capacitor

/// The app's bridge view controller (Main.storyboard). Registers the app's own
/// native plugins, which live in the app target rather than in an npm package.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(HorseFilesPlugin())
        // Cloud sync on phones: HTTP client, credential store, device label.
        bridge?.registerPluginInstance(HorseHttpPlugin())
        bridge?.registerPluginInstance(HorseSecureStorePlugin())
        bridge?.registerPluginInstance(HorseDevicePlugin())
        // PDF export on phones: off-screen WebKit print to PDF bytes.
        bridge?.registerPluginInstance(HorsePdfPlugin())
    }
}
