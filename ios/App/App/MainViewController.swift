import UIKit
import Capacitor

/// The app's bridge view controller (Main.storyboard). Registers the app's own
/// native plugins, which live in the app target rather than in an npm package.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(HorseFilesPlugin())
    }
}
