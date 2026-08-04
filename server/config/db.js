import mongoose from 'mongoose';

const connectDB = async () => {
  const uri = process.env.MONGO_URI?.trim();

  if (!uri) {
    console.error('MONGO_URI missing — add it in server/.env');
    process.exit(1);
  }

  try {
    const conn = await mongoose.connect(uri);
    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`MongoDB connection error: ${error.message}`);
    process.exit(1);
  }
};

export default connectDB;
