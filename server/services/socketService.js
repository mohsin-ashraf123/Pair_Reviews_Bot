import { Server } from 'socket.io';
import { createServer } from 'http';

let io = null;

export const initSocketServer = (app) => {
  const httpServer = createServer(app);
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
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

export const emitMemberRoomUpdate = (payload) => {
  io?.emit('member-room:update', payload);
};

export const emitMemberRoomMessage = (message) => {
  io?.emit('member-room:message', message);
};
