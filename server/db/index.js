// Opens the SQLite database and applies schema.sql.
//
// Uses sql.js (SQLite compiled to WebAssembly), so `npm install` needs no C++
// build tools on Windows, macOS or Linux. A small wrapper gives it the familiar
// prepare().run/get/all interface. With a file path the database is saved to
// disk after every write; the default is in-memory (see server/index.js).
const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

// sql.js cannot bind undefined or booleans.
const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === "boolean" ? Number(p) : p));

class Statement {
  constructor(owner, sql) {
    this.owner = owner;
    this.sql = sql;
  }

  run(...params) {
    const db = this.owner.raw;
    db.run(this.sql, clean(params));
    const changes = db.getRowsModified();
    const lastInsertRowid = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
    this.owner.persist();
    return { changes, lastInsertRowid };
  }

  all(...params) {
    const stmt = this.owner.raw.prepare(this.sql);
    try {
      stmt.bind(clean(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(...params) {
    return this.all(...params)[0];
  }
}

class Db {
  constructor(raw, file) {
    this.raw = raw;
    this.file = file;
    this.inTransaction = false;
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  exec(sql) {
    this.raw.exec(sql);
    this.persist();
  }

  pragma(text) {
    this.raw.run(`PRAGMA ${text}`);
  }

  // Wraps fn in BEGIN/COMMIT; rolls back if it throws.
  transaction(fn) {
    return (...args) => {
      this.raw.run("BEGIN");
      this.inTransaction = true;
      try {
        const result = fn(...args);
        this.raw.run("COMMIT");
        return result;
      } catch (err) {
        this.raw.run("ROLLBACK");
        throw err;
      } finally {
        this.inTransaction = false;
        this.persist();
      }
    };
  }

  persist() {
    if (this.file && !this.inTransaction) fs.writeFileSync(this.file, Buffer.from(this.raw.export()));
  }
}

async function openDatabase(file = ":memory:") {
  const SQL = await initSqlJs();
  const onDisk = file !== ":memory:";
  if (onDisk) fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = onDisk && fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
  const db = new Db(raw, onDisk ? file : null);
  db.pragma("foreign_keys = ON");
  db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  return db;
}

module.exports = { openDatabase };
