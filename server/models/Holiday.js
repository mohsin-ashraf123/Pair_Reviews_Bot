import mongoose from 'mongoose';

/** Calendar days the bot should treat like weekends (no room/DM automation). */
const holidaySchema = new mongoose.Schema(
  {
    dateKey: { type: String, required: true, unique: true },
    label: { type: String, default: 'Holiday' },
  },
  { timestamps: true }
);

const Holiday = mongoose.model('Holiday', holidaySchema);

export default Holiday;
