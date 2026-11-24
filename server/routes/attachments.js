// File attachments on a job: deliverables or briefs on a milestone, and files sent in the chat.
//
// Upload: POST /api/jobs/:id/attachments?name=<file name>[&milestone_id=<id>] with the file's bytes
// as the request body. Only the job's client and freelancer can upload; the client, freelancer and
// arbiter can download. Files are stored on disk under a random name and always sent back as a
// download (never shown inline), so an uploaded HTML or SVG file cannot run in someone's browser.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { wrap } = require("./util");

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file

// Allowed file types, by extension. Anything else is refused.
const TYPES = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// Keeps a readable file name: no folders, no control characters, at most 120 characters.
function cleanName(raw) {
  const base = path.basename(String(raw || "").replace(/\\/g, "/")).replace(/[\u0000-\u001f"<>|:*?]/g, "").trim();
  return base.slice(-120);
}

function publicAttachment(a) {
  const { stored_name, ...rest } = a;
  return rest;
}

module.exports = function attachmentRoutes({ db, auth, notifications, uploadDir }) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const router = express.Router();
  const getJob = (id) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  const isParty = (job, userId) => job && (userId === job.client_id || userId === job.freelancer_id);
  const canRead = (job, userId) => isParty(job, userId) || (job && userId === job.arbiter_id);

  router.post(
    "/jobs/:id/attachments",
    auth.requireAuth,
    express.raw({ type: () => true, limit: MAX_BYTES }),
    wrap(async (req, res) => {
      const job = getJob(req.params.id);
      if (!isParty(job, req.user.id) || !job.freelancer_id) return res.status(404).json({ error: "Job not found" });
      if (job.status !== "in_progress") return res.status(409).json({ error: "Files can only be added while the job is in progress" });
      const name = cleanName(req.query.name);
      const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
      if (!name || !TYPES[ext]) {
        return res.status(400).json({ error: `File type not allowed. Allowed: ${Object.keys(TYPES).join(", ")}` });
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: "The file is empty" });

      let milestoneId = null;
      if (req.query.milestone_id) {
        const m = db.prepare("SELECT * FROM milestones WHERE id = ? AND job_id = ?").get(req.query.milestone_id, job.id);
        if (!m) return res.status(404).json({ error: "Milestone not found on this job" });
        if (["released", "refunded", "cancelled"].includes(m.status)) {
          return res.status(409).json({ error: "This milestone is settled; no more files can be added" });
        }
        milestoneId = m.id;
      }

      const stored = crypto.randomBytes(16).toString("hex");
      await fs.promises.writeFile(path.join(uploadDir, stored), body);
      const info = db
        .prepare(
          `INSERT INTO attachments (job_id, milestone_id, uploader_id, filename, mime, size, stored_name)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(job.id, milestoneId, req.user.id, name, TYPES[ext], body.length, stored);
      if (milestoneId) {
        const other = req.user.id === job.client_id ? job.freelancer_id : job.client_id;
        notifications.notify(other, `New file on "${job.title}": ${name}`, `#/job/${job.id}`);
      }
      res.status(201).json(publicAttachment(db.prepare("SELECT * FROM attachments WHERE id = ?").get(info.lastInsertRowid)));
    })
  );

  router.get(
    "/attachments/:id",
    auth.requireAuth,
    wrap(async (req, res) => {
      const a = db.prepare("SELECT * FROM attachments WHERE id = ?").get(req.params.id);
      const job = a && getJob(a.job_id);
      if (!a || !canRead(job, req.user.id)) return res.status(404).json({ error: "File not found" });
      const file = path.join(uploadDir, a.stored_name);
      if (!fs.existsSync(file)) return res.status(410).json({ error: "This file is no longer stored on the server" });
      res.set({
        "Content-Type": a.mime,
        "Content-Length": String(a.size),
        "Content-Disposition": `attachment; filename="${a.filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      fs.createReadStream(file).pipe(res);
    })
  );

  // Turn a raw upload-size error into a clear answer instead of a server error.
  router.use((err, req, res, next) => {
    if (err && err.type === "entity.too.large") return res.status(413).json({ error: "The file is larger than 10 MB" });
    next(err);
  });

  return router;
};

module.exports.publicAttachment = publicAttachment;
