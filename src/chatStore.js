const messagesByOrder = new Map();

export const getMessages = (orderId) => {
  if (!messagesByOrder.has(orderId)) return [];
  return messagesByOrder.get(orderId);
};

export const addMessage = (orderId, message) => {
  const list = messagesByOrder.get(orderId) || [];
  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: message.text || '',
    senderId: message.senderId || null,
    senderName: message.senderName || 'Anon',
    createdAt: new Date().toISOString(),
  };
  list.push(msg);
  messagesByOrder.set(orderId, list);
  return msg;
};

export default { getMessages, addMessage };
