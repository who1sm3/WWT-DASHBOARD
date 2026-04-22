"""
AlertTracker LAN server
-----------------------
Serves the static site AND a shared data API so every PC on the same
network reads/writes the same records.

Data is stored locally in a SQLite database file (server_data.db) that
lives inside the project folder. Copying the whole project folder to
another PC carries the data with it.

Endpoints:
    GET /api/alerts        -> returns the shared JSON array
    PUT /api/alerts        -> replaces the shared JSON array (body = JSON array)
    anything else          -> static file from this folder

Run:
    python server.py
    (optional)  python server.py 8080

Then other PCs on the LAN open:
    http://<this-pc-ip>:3000
"""

import json
import mimetypes
import os
import socket
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT      = os.path.dirname(os.path.abspath(__file__))
DB_FILE   = os.path.join(ROOT, "server_data.db")
JSON_FILE = os.path.join(ROOT, "server_data.json")   # legacy, used once for migration
PORT      = int(sys.argv[1]) if len(sys.argv) > 1 else 3000

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("image/svg+xml",          ".svg")


def _connect():
    # check_same_thread=False so the ThreadingHTTPServer worker threads can share connections.
    # Each call still opens its own short-lived connection, which is the safe pattern with SQLite.
    conn = sqlite3.connect(DB_FILE, timeout=30, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL;")   # better concurrent reads while a write is happening
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


def init_db():
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS alerts (
                id   TEXT PRIMARY KEY,
                pos  INTEGER NOT NULL,
                data TEXT    NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_alerts_pos ON alerts(pos)")
        conn.commit()

    # One-time migration: if the DB is empty but the old JSON file exists, import it.
    with _connect() as conn:
        count = conn.execute("SELECT COUNT(*) FROM alerts").fetchone()[0]
    if count == 0 and os.path.exists(JSON_FILE):
        try:
            with open(JSON_FILE, "r", encoding="utf-8") as f:
                legacy = json.load(f)
            if isinstance(legacy, list) and legacy:
                _replace_all(legacy)
                print(f"Migrated {len(legacy)} records from server_data.json into SQLite.")
        except Exception as e:
            print("Legacy JSON migration skipped:", e)


def read_data():
    with _connect() as conn:
        rows = conn.execute("SELECT data FROM alerts ORDER BY pos ASC").fetchall()
    out = []
    for (raw,) in rows:
        try:
            out.append(json.loads(raw))
        except Exception:
            continue
    return out


def _replace_all(arr):
    """Replace the entire alerts table with the given list, in one transaction."""
    rows = []
    for i, rec in enumerate(arr):
        if not isinstance(rec, dict):
            continue
        rid = rec.get("id")
        if not rid:
            # Skip records with no id rather than silently overwriting; the frontend always assigns one.
            continue
        rows.append((str(rid), i, json.dumps(rec, ensure_ascii=False)))

    with _connect() as conn:
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM alerts")
            conn.executemany(
                "INSERT OR REPLACE INTO alerts (id, pos, data) VALUES (?, ?, ?)",
                rows,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def write_data(arr):
    _replace_all(arr)


def safe_static_path(url_path):
    """Resolve a URL path to an absolute file path, refusing anything outside ROOT."""
    rel = "/index.html" if url_path in ("", "/") else url_path
    rel = rel.split("?", 1)[0].split("#", 1)[0]
    candidate = os.path.normpath(os.path.join(ROOT, rel.lstrip("/\\")))
    if not candidate.startswith(ROOT):
        return None
    return candidate


# Filenames that must never be served over the static route.
_BLOCKED_STATIC = {"server_data.db", "server_data.db-wal", "server_data.db-shm", "server_data.json"}


class Handler(BaseHTTPRequestHandler):
    server_version = "AlertTracker/1.1"

    # Silence the default noisy per-request logging; keep errors.
    def log_message(self, fmt, *args):
        if "code 4" in (fmt % args) or "code 5" in (fmt % args):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # Static site and API are served from the same origin, so CORS is unnecessary.
    def _cors(self):
        pass

    # --- API ---
    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/alerts":
            body = json.dumps(read_data()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
            return
        self._serve_static()

    def do_PUT(self):
        if self.path.split("?", 1)[0] != "/api/alerts":
            self.send_error(404); return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 20 * 1024 * 1024:   # 20 MB hard cap
            self.send_error(413, "Payload too large"); return

        raw = self.rfile.read(length)
        try:
            parsed = json.loads(raw.decode("utf-8"))
            if not isinstance(parsed, list):
                raise ValueError("Body must be a JSON array")
            write_data(parsed)
        except Exception as e:
            msg = json.dumps({"ok": False, "error": str(e)}).encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self._cors()
            self.end_headers()
            self.wfile.write(msg)
            return

        ok = json.dumps({"ok": True, "count": len(parsed)}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(ok)))
        self._cors()
        self.end_headers()
        self.wfile.write(ok)

    # --- Static files ---
    def _serve_static(self):
        path = safe_static_path(self.path)
        if path is None:
            self.send_error(403); return

        # Never expose the database or the legacy JSON over the static route
        if os.path.basename(path) in _BLOCKED_STATIC:
            self.send_error(403); return

        if not os.path.isfile(path):
            self.send_error(404); return

        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(500); return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self._cors()
        self.end_headers()
        self.wfile.write(data)


def lan_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            ip = info[4][0]
            if ":" in ip:               # skip IPv6
                continue
            if ip.startswith("127."):
                continue
            ips.add(ip)
    except Exception:
        pass
    return sorted(ips)


def main():
    init_db()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("-" * 60)
    print(f"  AlertTracker server running on port {PORT}")
    print(f"  Database:   {DB_FILE}")
    print()
    print("  Open on this PC:")
    print(f"    http://localhost:{PORT}")
    print()
    print("  Open from other PCs on the same network:")
    ips = lan_ips()
    if ips:
        for ip in ips:
            print(f"    http://{ip}:{PORT}")
    else:
        print("    (no LAN IP detected — check your network)")
    print("-" * 60)
    print("  Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.server_close()


if __name__ == "__main__":
    main()
