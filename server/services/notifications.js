// Notifications (FR16). STUB: messages are stored in the notifications table so the
// rest of the system can already call notify(); delivery (email, in-app badge,
// websocket push) is not implemented yet.
function makeNotifications(db) {
  const insert = db.prepare("INSERT INTO notifications (user_id, message) VALUES (?, ?)");
  function notify(userId, message) {
    if (userId) insert.run(userId, message);
    // TODO: deliver by email / push.
  }
  return { notify };
}

module.exports = { makeNotifications };
