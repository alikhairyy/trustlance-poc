// Notifications (FR16). Stored per user with a link to the page they are about, shown in the
// app's bell menu with an unread count. Email delivery is not built yet: it needs a mail service.
function makeNotifications(db) {
  const insert = db.prepare("INSERT INTO notifications (user_id, message, link) VALUES (?, ?, ?)");
  function notify(userId, message, link = "") {
    if (userId) insert.run(userId, message, link);
  }
  return { notify };
}

module.exports = { makeNotifications };
