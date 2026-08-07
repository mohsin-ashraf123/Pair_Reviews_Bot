import mongoose from 'mongoose';

/** Personal Element room where the bot follows up with a single team member. */
const memberRoomSchema = new mongoose.Schema(
  {
    member: { type: String, required: true, unique: true },
    roomId: { type: String, required: true, unique: true },
    team: { type: String, enum: ['developer', 'qa'], default: 'developer' },
    active: { type: Boolean, default: true },
    joined: { type: Boolean, default: false },
    joinError: String,
    lastPromptAt: Date,
    lastReplyAt: Date,
    lastMessageAt: Date,
  },
  { timestamps: true }
);

const MemberRoom = mongoose.model('MemberRoom', memberRoomSchema);

export default MemberRoom;
