import { Server } from 'socket.io';
import { createServer } from 'http';
import { verifyToken } from './dashboardAuth.js';

let io = null;

export const initSocketServer = (app) => {
  const httpServer = createServer(app);
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.use((socket, next) => {
    const auth = verifyToken(socket.handshake.auth?.token);
    if (!auth) return next(new Error('Please sign in.'));
    const expiryTimer = setTimeout(() => socket.disconnect(true), auth.expires - Date.now());
    expiryTimer.unref?.();
    socket.on('disconnect', () => clearTimeout(expiryTimer));
    next();
  });
  io.on('connection', (socket) => {
    console.log('Dashboard connected:', socket.id);
    socket.on('disconnect', () => {
      console.log('Dashboard disconnected:', socket.id);
    });
  });

  return httpServer;
};

export const getIo = () => io;

export const emitRoomMessage = (message) => {
  io?.emit('room:message', message);
};

export const emitRoomMessageDeleted = (eventId) => {
  io?.emit('room:message:deleted', { eventId });
};

export const emitReviewUpdate = (reviewState) => {
  io?.emit('review:update', reviewState);
};

export const emitCountdownTick = (countdown) => {
  io?.emit('countdown:update', countdown);
};

export const emitSchedulesTick = (schedules) => {
  io?.emit('schedules:update', schedules);
};

export const emitMemberRoomUpdate = (payload) => {
  io?.emit('member-room:update', payload);
};

export const emitMemberRoomMessage = (message) => {
  io?.emit('member-room:message', message);
};

export const emitThreadUpdate = (thread) => {
  io?.emit('thread:update', thread);
};
