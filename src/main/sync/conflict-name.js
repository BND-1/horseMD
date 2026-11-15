import os from 'node:os'
import {
  conflictCopyName,
  conflictStamp,
  conflictSuffixFor as sharedConflictSuffixFor,
  deviceLabel as sharedDeviceLabel
} from '../../shared/sync/conflict-name.js'

// Desktop defaults for the shared conflict-copy names: the device is the
// computer's host name.
const hostname = () => { try { return os.hostname() } catch { return '' } }

export function deviceLabel(name = hostname()) {
  return sharedDeviceLabel(name)
}

export const conflictSuffixFor = (deviceName = deviceLabel(), date = new Date()) => sharedConflictSuffixFor(deviceName, date)

export { conflictCopyName, conflictStamp }
