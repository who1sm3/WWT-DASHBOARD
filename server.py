"""
AlertTracker LAN server
-----------------------
Serves the static site AND a shared data API so every PC on the same
network reads/writes the same records.

Data is stored locally in a SQLite database file (server_data.db) that
lives inside the project folder. Copying the whole project folder to
another PC carries the data with it.

Endpoints:
    GET  /api/alerts       -> returns the shared alerts JSON array
    PUT  /api/alerts       -> replaces the shared alerts JSON array (body = JSON array)
    GET  /api/dorks        -> returns the saved dork queries
    PUT  /api/dorks        -> replaces the saved dork queries (body = JSON array)
    GET  /api/tickets      -> last 20 generated ticket codes
    POST /api/tickets      -> generate a new ticket code (body = {prefix, date})
    anything else          -> static file from this folder

Run:
    python server.py
    (optional)  python server.py 8080

Then other PCs on the LAN open:
    http://<this-pc-ip>:3000
"""

import datetime
import json
import mimetypes
import os
import random
import socket
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT       = os.path.dirname(os.path.abspath(__file__))
DB_FILE    = os.path.join(ROOT, "server_data.db")
DORK_DB    = os.path.join(ROOT, "dorking_data.db")
DORK_SEED  = os.path.join(ROOT, "dorking_data.json")  # default dorks seeded into the DB on first run
LEARN_DB   = os.path.join(ROOT, "learning_data.db")
LEARN_SEED = os.path.join(ROOT, "learning_data.json") # default learning resources seeded on first run
JSON_FILE  = os.path.join(ROOT, "server_data.json")   # legacy, used once for migration
PORT       = int(sys.argv[1]) if len(sys.argv) > 1 else 3000

# Ticket ID generator — matches Code.py's path & line format exactly.
TICKET_DIR  = os.path.join(os.path.expanduser("~"), "Documents", "Generated Code")
TICKET_FILE = os.path.join(TICKET_DIR, "generated_codes.txt")

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("image/svg+xml",          ".svg")


def _connect(db_path=None):
    # check_same_thread=False so the ThreadingHTTPServer worker threads can share connections.
    # Each call still opens its own short-lived connection, which is the safe pattern with SQLite.
    conn = sqlite3.connect(db_path or DB_FILE, timeout=30, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL;")   # better concurrent reads while a write is happening
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


# Default dorks are loaded from dorking_data.json on first run (mirrors how
# alert_data.json seeds the alert table). Edit that file to curate the seeds.
def load_default_dorks():
    if not os.path.exists(DORK_SEED):
        return []
    try:
        with open(DORK_SEED, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"Could not read {DORK_SEED}: {e}")
        return []
    if isinstance(data, list):
        records = data
    elif isinstance(data, dict):
        records = data.get("records") or data.get("dorks") or []
    else:
        records = []
    cleaned = []
    for r in records:
        if not isinstance(r, dict):
            continue
        if not r.get("query"):
            continue
        cleaned.append({
            "category": r.get("category") or "",
            "title": r.get("title") or "",
            "query": r["query"],
            "description": r.get("description") or "",
        })
    return cleaned


def _stable_default_key(d):
    import hashlib
    raw = "dork-default::" + (d.get("category") or "") + "::" + (d.get("title") or "") + "::" + (d.get("query") or "")
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def init_dork_db():
    with _connect(DORK_DB) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS dorks (
                id          TEXT PRIMARY KEY,
                pos         INTEGER NOT NULL,
                category    TEXT,
                title       TEXT,
                query       TEXT NOT NULL,
                description TEXT,
                created_at  TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dorks_pos ON dorks(pos)")
        cols = {r[1] for r in conn.execute("PRAGMA table_info(dorks)").fetchall()}
        if "seed_key" not in cols:
            conn.execute("ALTER TABLE dorks ADD COLUMN seed_key TEXT")
        conn.commit()

    import time, uuid
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    defaults = load_default_dorks()
    if not defaults:
        return

    # Backfill seed_key on existing rows so previously-seeded defaults are
    # recognized even if the user has edited the query. Match by exact query
    # first; fall back to (category, title) which survives query edits.
    with _connect(DORK_DB) as conn:
        rows = conn.execute(
            "SELECT id, category, title, query, seed_key FROM dorks"
        ).fetchall()
        used_keys = {r[4] for r in rows if r[4]}
        by_query = {}
        by_cat_title = {}
        for rid, cat, title, q, sk in rows:
            if sk:
                continue
            by_query.setdefault(q or "", []).append(rid)
            by_cat_title.setdefault(((cat or ""), (title or "")), []).append(rid)

        claimed = set()
        updates = []
        for d in defaults:
            key = _stable_default_key(d)
            if key in used_keys:
                continue
            candidates = [i for i in by_query.get(d["query"], []) if i not in claimed]
            if not candidates:
                candidates = [i for i in by_cat_title.get((d["category"], d["title"]), []) if i not in claimed]
            if candidates:
                rid = candidates[0]
                claimed.add(rid)
                used_keys.add(key)
                updates.append((key, rid))
        if updates:
            conn.executemany("UPDATE dorks SET seed_key = ? WHERE id = ?", updates)
            conn.commit()

    # Seed only defaults whose seed_key is not already present.
    with _connect(DORK_DB) as conn:
        seeded = {r[0] for r in conn.execute(
            "SELECT seed_key FROM dorks WHERE seed_key IS NOT NULL"
        ).fetchall()}
    new_defaults = [d for d in defaults if _stable_default_key(d) not in seeded]
    if not new_defaults:
        return

    new_entries = [{
        "id": uuid.uuid4().hex,
        "category": d["category"], "title": d["title"], "query": d["query"],
        "description": d.get("description", ""), "created_at": now,
        "seed_key": _stable_default_key(d),
    } for d in new_defaults]

    existing = read_dorks()
    if not existing:
        _dork_replace_all(new_entries)
    else:
        _dork_replace_all(existing + new_entries)
        print(f"Seeded {len(new_entries)} new default dork(s).")


def read_dorks():
    with _connect(DORK_DB) as conn:
        rows = conn.execute(
            "SELECT id, category, title, query, description, created_at FROM dorks ORDER BY pos ASC"
        ).fetchall()
    return [
        {"id": r[0], "category": r[1] or "", "title": r[2] or "", "query": r[3] or "",
         "description": r[4] or "", "created_at": r[5] or ""}
        for r in rows
    ]


def _dork_replace_all(arr):
    staged = []
    for i, rec in enumerate(arr):
        if not isinstance(rec, dict):
            continue
        rid = rec.get("id")
        q   = rec.get("query")
        if not rid or not q:
            continue
        staged.append((str(rid), i, rec, q))
    with _connect(DORK_DB) as conn:
        try:
            conn.execute("BEGIN IMMEDIATE")
            existing_keys = {r[0]: r[1] for r in conn.execute(
                "SELECT id, seed_key FROM dorks"
            ).fetchall()}
            conn.execute("DELETE FROM dorks")
            rows = []
            for rid, pos, rec, q in staged:
                seed_key = rec.get("seed_key")
                if seed_key is None:
                    seed_key = existing_keys.get(rid)
                rows.append((
                    rid, pos,
                    rec.get("category") or "",
                    rec.get("title") or "",
                    q,
                    rec.get("description") or "",
                    rec.get("created_at") or "",
                    seed_key,
                ))
            conn.executemany(
                "INSERT OR REPLACE INTO dorks (id, pos, category, title, query, description, created_at, seed_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def write_dorks(arr):
    _dork_replace_all(arr)


# --- Learning resources (free certification courses, mirrors dork pattern) ---

def load_default_learning():
    """Read learning_data.json (same format conventions as dorking_data.json)."""
    if not os.path.exists(LEARN_SEED):
        return []
    try:
        with open(LEARN_SEED, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"Could not read {LEARN_SEED}: {e}")
        return []
    if isinstance(data, list):
        records = data
    elif isinstance(data, dict):
        records = data.get("records") or data.get("resources") or []
    else:
        records = []
    cleaned = []
    for r in records:
        if not isinstance(r, dict):
            continue
        if not r.get("url"):
            continue
        cleaned.append({
            "category": r.get("category") or "",
            "title": r.get("title") or "",
            "url": r["url"],
            "description": r.get("description") or "",
        })
    return cleaned


def _stable_learn_key(d):
    import hashlib
    raw = "learn-default::" + (d.get("category") or "") + "::" + (d.get("title") or "") + "::" + (d.get("url") or "")
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def init_learn_db():
    with _connect(LEARN_DB) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS learning (
                id          TEXT PRIMARY KEY,
                pos         INTEGER NOT NULL,
                category    TEXT,
                title       TEXT,
                url         TEXT NOT NULL,
                description TEXT,
                created_at  TEXT,
                seed_key    TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_learn_pos ON learning(pos)")
        conn.commit()

    import time, uuid
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    defaults = load_default_learning()
    if not defaults:
        return

    # Backfill seed_key on existing rows so user-edited resources still match.
    with _connect(LEARN_DB) as conn:
        rows = conn.execute(
            "SELECT id, category, title, url, seed_key FROM learning"
        ).fetchall()
        used_keys = {r[4] for r in rows if r[4]}
        by_url = {}
        by_cat_title = {}
        for rid, cat, title, u, sk in rows:
            if sk:
                continue
            by_url.setdefault(u or "", []).append(rid)
            by_cat_title.setdefault(((cat or ""), (title or "")), []).append(rid)

        claimed = set()
        updates = []
        for d in defaults:
            key = _stable_learn_key(d)
            if key in used_keys:
                continue
            candidates = [i for i in by_url.get(d["url"], []) if i not in claimed]
            if not candidates:
                candidates = [i for i in by_cat_title.get((d["category"], d["title"]), []) if i not in claimed]
            if candidates:
                rid = candidates[0]
                claimed.add(rid)
                used_keys.add(key)
                updates.append((key, rid))
        if updates:
            conn.executemany("UPDATE learning SET seed_key = ? WHERE id = ?", updates)
            conn.commit()

    with _connect(LEARN_DB) as conn:
        seeded = {r[0] for r in conn.execute(
            "SELECT seed_key FROM learning WHERE seed_key IS NOT NULL"
        ).fetchall()}
    new_defaults = [d for d in defaults if _stable_learn_key(d) not in seeded]
    if not new_defaults:
        return

    new_entries = [{
        "id": uuid.uuid4().hex,
        "category": d["category"], "title": d["title"], "url": d["url"],
        "description": d.get("description", ""), "created_at": now,
        "seed_key": _stable_learn_key(d),
    } for d in new_defaults]

    existing = read_learning()
    if not existing:
        _learn_replace_all(new_entries)
    else:
        _learn_replace_all(existing + new_entries)
        print(f"Seeded {len(new_entries)} new learning resource(s).")


def read_learning():
    with _connect(LEARN_DB) as conn:
        rows = conn.execute(
            "SELECT id, category, title, url, description, created_at FROM learning ORDER BY pos ASC"
        ).fetchall()
    return [
        {"id": r[0], "category": r[1] or "", "title": r[2] or "", "url": r[3] or "",
         "description": r[4] or "", "created_at": r[5] or ""}
        for r in rows
    ]


def _learn_replace_all(arr):
    staged = []
    for i, rec in enumerate(arr):
        if not isinstance(rec, dict):
            continue
        rid = rec.get("id")
        u   = rec.get("url")
        if not rid or not u or not isinstance(u, str):
            continue
        # Reject non-http(s) URLs and oversize values to keep junk out of the DB.
        u = u.strip()
        if len(u) > 2000:
            continue
        if not (u.startswith("http://") or u.startswith("https://")):
            continue
        staged.append((str(rid), i, rec, u))
    with _connect(LEARN_DB) as conn:
        try:
            conn.execute("BEGIN IMMEDIATE")
            existing_keys = {r[0]: r[1] for r in conn.execute(
                "SELECT id, seed_key FROM learning"
            ).fetchall()}
            conn.execute("DELETE FROM learning")
            rows = []
            for rid, pos, rec, u in staged:
                seed_key = rec.get("seed_key")
                if seed_key is None:
                    seed_key = existing_keys.get(rid)
                rows.append((
                    rid, pos,
                    rec.get("category") or "",
                    rec.get("title") or "",
                    u,
                    rec.get("description") or "",
                    rec.get("created_at") or "",
                    seed_key,
                ))
            conn.executemany(
                "INSERT OR REPLACE INTO learning (id, pos, category, title, url, description, created_at, seed_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def write_learning(arr):
    _learn_replace_all(arr)


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
    # Proper containment check: candidate must equal ROOT or live under ROOT + sep.
    # Prevents "/proj" matching "/proj-other/..." via startswith().
    root_with_sep = ROOT + os.sep
    if candidate != ROOT and not candidate.startswith(root_with_sep):
        return None
    return candidate


# Filenames / patterns that must never be served over the static route.
# Compared case-insensitively so Windows' case-insensitive FS can't bypass.
_BLOCKED_STATIC = {
    "server_data.db", "server_data.db-wal", "server_data.db-shm", "server_data.json",
    "dorking_data.db", "dorking_data.db-wal", "dorking_data.db-shm",
    "learning_data.db", "learning_data.db-wal", "learning_data.db-shm",
}
# Source files and dotfiles must never leak over the static route.
_BLOCKED_EXTENSIONS = {".py", ".pyc", ".pyo", ".db", ".sqlite", ".sqlite3", ".env", ".ini"}


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
    def _send_json(self, status, payload):
        # Compact separators + ensure_ascii=False match JS's JSON.stringify
        # byte-for-byte (raw UTF-8, no whitespace), so polling snapshots can
        # short-circuit cleanly even when records contain non-ASCII characters.
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = self.path.split("?", 1)[0]
        if route == "/api/alerts":
            self._send_json(200, read_data()); return
        if route == "/api/dorks":
            self._send_json(200, read_dorks()); return
        if route == "/api/learning":
            self._send_json(200, read_learning()); return
        if route == "/api/tickets":
            self._send_json(200, _ticket_history(limit=20)); return

        # Browsers auto-request these — serve/ignore silently instead of logging 404s.
        if route == "/favicon.ico":
            # Re-use logo.png as the favicon.
            path = os.path.join(ROOT, "logo.png")
            if os.path.isfile(path):
                with open(path, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_response(204); self.end_headers(); return

        # Chrome DevTools probes + stray source-map requests when DevTools is open.
        if (route.startswith("/.well-known/")
                or route.endswith(".map")
                or route == "/robots.txt"):
            self.send_response(204); self.end_headers(); return

        self._serve_static()

    def do_POST(self):
        route = self.path.split("?", 1)[0]
        if route != "/api/tickets":
            self.send_error(404); return

        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > 64 * 1024:
            self.send_error(413, "Payload too large"); return

        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(body, dict):
                raise ValueError("Body must be a JSON object")
            prefix = body.get("prefix", "INC:")
            date_str = body.get("date", "")
            if not isinstance(prefix, str) or len(prefix) > 32:
                raise ValueError("Invalid prefix")
            if not isinstance(date_str, str) or len(date_str) > 32:
                raise ValueError("Invalid date")
        except Exception as e:
            self._send_json(400, {"ok": False, "error": str(e)}); return

        result = generate_ticket(prefix, date_str)
        self._send_json(200 if result.get("ok") else 500, result)

    def do_PUT(self):
        route = self.path.split("?", 1)[0]
        if route not in ("/api/alerts", "/api/dorks", "/api/learning"):
            self.send_error(404); return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 20 * 1024 * 1024:   # 20 MB hard cap
            self.send_error(413, "Payload too large"); return

        raw = self.rfile.read(length)
        try:
            parsed = json.loads(raw.decode("utf-8"))
            if not isinstance(parsed, list):
                raise ValueError("Body must be a JSON array")
            if route == "/api/alerts":
                write_data(parsed)
            elif route == "/api/dorks":
                write_dorks(parsed)
            else:
                write_learning(parsed)
        except Exception as e:
            self._send_json(400, {"ok": False, "error": str(e)}); return

        self._send_json(200, {"ok": True, "count": len(parsed)})

    # --- Static files ---
    def _serve_static(self):
        path = safe_static_path(self.path)
        if path is None:
            self.send_error(403); return

        base_lower = os.path.basename(path).lower()
        ext_lower = os.path.splitext(base_lower)[1]

        # Never expose the database/legacy JSON, source files, or dotfiles.
        if (base_lower in _BLOCKED_STATIC
                or ext_lower in _BLOCKED_EXTENSIONS
                or base_lower.startswith(".")
                or "__pycache__" in path.lower().split(os.sep)):
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
        # Security headers — X-Frame-Options only works as an HTTP header,
        # not via <meta http-equiv>, so the site is actually clickjack-protected now.
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self._cors()
        self.end_headers()
        self.wfile.write(data)


## -- Ticket ID Generator (ported from Code.py, same algorithm & file format) --

def _ticket_generate_mix_code():
    vowels     = 'AEIOU'
    consonants = 'BCDFGHJKLMNPQRSTVWXYZ'
    digits     = '0123456789'
    return (
        random.choice(consonants) +
        random.choice(vowels) +
        random.choice(consonants) +
        random.choice(digits) +
        random.choice(vowels) +
        random.choice(consonants)
    )


def _ticket_existing_codes():
    if not os.path.exists(TICKET_FILE):
        return set()
    codes = set()
    try:
        with open(TICKET_FILE, "r", encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split()
                if parts:
                    codes.add(parts[-1])
    except OSError:
        pass
    return codes


def _ticket_save_code(full_code):
    os.makedirs(TICKET_DIR, exist_ok=True)
    now = datetime.datetime.now()
    timestamp = now.strftime("[%Y-%m-%d][%H:%M:%S]")
    with open(TICKET_FILE, "a", encoding="utf-8") as f:
        f.write(f"{timestamp} {full_code}\n")
    return timestamp


def _ticket_history(limit=20):
    if not os.path.exists(TICKET_FILE):
        return []
    out = []
    try:
        with open(TICKET_FILE, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return []
    for line in lines[-limit:][::-1]:
        s = line.strip()
        if not s:
            continue
        parts = s.split()
        if len(parts) >= 2:
            out.append({"timestamp": " ".join(parts[:-1]), "code": parts[-1]})
    return out


def generate_ticket(prefix, date_str):
    prefix = "INC:" if prefix is None else str(prefix)
    date_str = "" if date_str is None else str(date_str).strip()
    if not date_str:
        date_str = datetime.date.today().strftime("%Y%m%d")

    existing = _ticket_existing_codes()
    for attempt in range(1, 1001):
        code = _ticket_generate_mix_code()
        full_code = f"{prefix}{date_str}-{code}"
        if full_code not in existing:
            timestamp = _ticket_save_code(full_code)
            return {
                "ok": True,
                "full_code": full_code,
                "code": code,
                "prefix": prefix,
                "date": date_str,
                "timestamp": timestamp,
                "attempts": attempt,
                "saved_to": TICKET_FILE,
            }
    return {"ok": False, "error": "Failed to generate a unique code after 1000 attempts. Please try again."}


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
    init_dork_db()
    init_learn_db()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("-" * 60)
    print(f"  AlertTracker server running on port {PORT}")
    print(f"  Alerts DB:    {DB_FILE}")
    print(f"  Dorks DB:     {DORK_DB}")
    print(f"  Learning DB:  {LEARN_DB}")
    print(f"  Tickets:      {TICKET_FILE}")
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
