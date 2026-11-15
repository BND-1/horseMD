// Where the phone keeps its sync documents (connections, sync folders, sync
// state, merge ancestors): app-private and never backed up — iOS
// Library/NoCloud (Directory.LibraryNoCloud, excluded from iCloud / iTunes
// backups), Android's files dir (Directory.Data; horsemd-sync/ is excluded in
// android/app/src/main/res/xml/backup_rules.xml + data_extraction_rules.xml).
// A sync state copied to another phone would make two phones look like one
// device to the cloud. Tiny on purpose: capacitor-api.js imports it eagerly
// to answer "nothing set up yet" without loading the sync engine.
import { Capacitor } from '@capacitor/core'
import { Directory } from '@capacitor/filesystem'

export const STORE_ROOT = 'horsemd-sync'
export const storeDirectory = () => (Capacitor.getPlatform() === 'ios' ? Directory.LibraryNoCloud : Directory.Data)
// Either file exists once a sync folder or a connection was added.
export const STORE_SETUP_FILES = ['sync/workspace-registry.json', 'sync/connections.json'].map((name) => `${STORE_ROOT}/${name}`)
