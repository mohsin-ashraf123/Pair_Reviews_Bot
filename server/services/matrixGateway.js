// Keep native E2EE bindings out of the dashboard's import graph. Missing host
// libraries must fail a Matrix operation, not prevent all API routes loading.
const call = async (name, args) => {
  const service = await import('./matrixService.js');
  return service[name](...args);
};

export const getMatrixClient = (...args) => call('getMatrixClient', args);
export const sendMatrixMessage = (...args) => call('sendMatrixMessage', args);
export const sendMatrixImage = (...args) => call('sendMatrixImage', args);
export const sendMatrixMessageToRoom = (...args) => call('sendMatrixMessageToRoom', args);
export const sendMatrixThreadReply = (...args) => call('sendMatrixThreadReply', args);
export const joinMatrixRoom = (...args) => call('joinMatrixRoom', args);
export const verifyMatrixConnection = async (...args) => {
  try {
    return await call('verifyMatrixConnection', args);
  } catch (error) {
    return { ok: false, message: `Matrix runtime unavailable: ${error.message}` };
  }
};
