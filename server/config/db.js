import mongoose from 'mongoose';

const connectDB = async () => {
  const uri = process.env.MONGO_URI?.trim();

  if (!uri) {
    throw new Error('MONGO_URI missing — add it in Railway Variables or server/.env');
  }

  const conn = await mongoose.connect(uri);
  console.log(`MongoDB connected: ${conn.connection.host}`);
  return conn;
};

export default connectDB;
