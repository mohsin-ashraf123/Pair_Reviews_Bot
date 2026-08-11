import mongoose from 'mongoose';

/**
 * Survives Railway ephemeral disks: session token + crypto/storage files
 * for the single bot device. Without this, every restart password-logins a
 * new Element device and triggers "It was me" prompts.
 */
const matrixDeviceStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'primary' },
    session: {
      homeserver: String,
      accessToken: String,
      userId: String,
      deviceId: String,
      createdAt: String,
      via: String,
    },
    /** gzip(JSON({ files: { relativePath: base64 } })) */
    archive: { type: Buffer },
    archiveBytes: Number,
    deviceId: { type: String, index: true },
  },
  { timestamps: true }
);

const MatrixDeviceState = mongoose.model('MatrixDeviceState', matrixDeviceStateSchema);

export default MatrixDeviceState;
