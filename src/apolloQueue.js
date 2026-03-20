const { randomUUID } = require('crypto');

const TIMEOUT_MS = 120_000; // 2 minutes for Claude to fulfill
const pending = new Map();

function enqueue(type, payload) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Apollo lookup timed out (${type})`));
    }, TIMEOUT_MS);
    pending.set(id, { id, type, payload, createdAt: Date.now(), resolve, reject, timer });
    console.log(`[queue] ${type} ${id.slice(0, 8)}`);
  });
}

module.exports = { enqueue, pending };
