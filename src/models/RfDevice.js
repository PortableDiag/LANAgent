import mongoose from 'mongoose';

/**
 * RfDevice — normalized RF presence record for the home-defense module.
 *
 * One collection holds every observed RF entity regardless of capture backend
 * (in-house watchers or Kismet) and band (WiFi or Bluetooth). The capture
 * engine's native record is mapped into this common shape once, in the
 * home-defense plugin, so the API / WebUI / rules engine stay backend-agnostic.
 *
 * `deviceId` is the stable key: a BSSID/MAC for WiFi-AP / BT, or a rotating
 * identifier for privacy-MAC BLE. It is NOT validated as a strict MAC because
 * hidden APs and randomized BLE addresses legitimately deviate.
 */
const rfDeviceSchema = new mongoose.Schema({
  deviceId:   { type: String, required: true, unique: true, index: true },
  type: {
    type: String,
    enum: ['wifi_ap', 'wifi_client', 'bt_classic', 'ble', 'unknown'],
    default: 'unknown',
    index: true
  },

  // Identity / radio
  name:     { type: String, default: '' },   // SSID for WiFi, device name for BT
  ssid:     { type: String, default: '' },
  vendor:   { type: String, default: '' },   // OUI lookup; '' for randomized MACs
  band:     { type: String, default: '' },   // 2.4 / 5 / bt
  channel:  { type: Number, default: null },
  freq:     { type: Number, default: null },
  security: { type: String, default: '' },   // WiFi encryption / BT class

  // Signal + presence
  rssiLast:    { type: Number, default: null },
  rssiPeak:    { type: Number, default: null },
  firstSeen:   { type: Date, index: true },
  lastSeen:    { type: Date, index: true },
  packetCount: { type: Number, default: 0 },

  // Operator annotations (write side)
  known: { type: Boolean, default: false, index: true },
  trust: {
    type: String,
    enum: ['trusted', 'unknown', 'flagged'],
    default: 'unknown',
    index: true
  },
  label: { type: String, default: '' },
  notes: { type: String, default: '' },

  // Flags surfaced by the backend
  hidden: { type: Boolean, default: false },   // hidden SSID
  threat: { type: Boolean, default: false },   // backend-flagged threat (e.g. open AP)

  // Provenance
  source:   { type: String, default: '', index: true },  // e.g. 'inhouse:wifi' | 'kismet'
  backendKey: { type: String, default: '' },             // back-reference for drill-down
  raw:      { type: mongoose.Schema.Types.Mixed }         // last normalized backend record
}, { timestamps: true });

rfDeviceSchema.index({ source: 1, lastSeen: -1 });

/**
 * Upsert a normalized record. Preserves operator annotations (trust/label/notes
 * and the `known` flag) — those are owned by LANAgent, not the capture backend,
 * so a backend refresh must never clobber them.
 */
rfDeviceSchema.statics.upsertNormalized = async function (rec) {
  if (!rec || !rec.deviceId) return null;
  const set = { ...rec };
  // Annotation fields are operator-owned: only seed them on first insert.
  delete set.trust;
  delete set.label;
  delete set.notes;
  delete set.known;
  // firstSeen must be STABLE per deviceId. The capture backend re-timestamps a
  // device's first_seen when it drops out (signal flap / out of range) and
  // reappears; if we $set that, firstSeen marches forward, the device re-enters
  // the "new" window, and the home-defense alert loop notifies about the same
  // MAC over and over. Keep the EARLIEST timestamp ever recorded via $min so a
  // re-observation can only ever pull it earlier, never forward. lastSeen still
  // tracks the latest sighting via $set.
  const firstSeen = set.firstSeen;
  delete set.firstSeen;
  const update = {
    $set: set,
    $setOnInsert: {
      trust: rec.trust || 'unknown',
      label: rec.label || '',
      notes: rec.notes || '',
      known: !!rec.known
    }
  };
  if (firstSeen) update.$min = { firstSeen };
  return this.findOneAndUpdate(
    { deviceId: rec.deviceId },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

export const RfDevice = mongoose.models.RfDevice || mongoose.model('RfDevice', rfDeviceSchema);
export default RfDevice;
