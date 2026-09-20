if True:
        """MindTrace server: static files plus a small accounts API.

        Dependency-free — standard library only, so there is nothing to pip install.

        Data lives in ./data/db.json. Replit's filesystem persists between runs, so an
        account follows its email across devices and browsers hitting this URL. It does
        NOT survive a fork or a redeploy, so export your CSV before either.

        SECURITY, PLAINLY: passwords are salted and hashed with PBKDF2, which is the
        right primitive, but there is no email verification, no rate limiting, no
        password reset, and traffic is plain HTTP unless Replit terminates TLS for you.
        This is fine for a prototype and a demo. Do not put real patient data in it.

        API
          POST   /api/signup    {email, password, name, birthYear?}  -> {token, user}
          POST   /api/signin    {email, password}                    -> {token, user}
          GET    /api/me                                             -> {user, sessions}
          POST   /api/sessions  {session}                            -> {ok, sessions}
          PUT    /api/profile   {name?, birthYear?, theme?}          -> {user}
          GET    /api/friends                                        -> {friends, inviteCode}
          POST   /api/friends   {code}                               -> {ok, friends}
          DELETE /api/friends   {friendId}                           -> {ok, friends}

        All authenticated routes take  Authorization: Bearer <token>.

        Friends only ever expose name, streak and session count — never a cognitive
        score. Ranking people by performance would make them try harder to climb,
        and that effort variance corrupts the very thing MindTrace measures.
        """

        # Python 3.11 supports the type syntax used below directly.

        import hashlib
        import json
        import os
        import re
        import secrets
        import threading
        from datetime import date, datetime
        from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
        from pathlib import Path

        ROOT = Path(__file__).resolve().parent
        DATA_DIR = ROOT / "data"
        DB_PATH = DATA_DIR / "db.json"
        PORT = int(os.environ.get("PORT", "8080"))

        ALLOWED_FILES = {
            "/": "index.html",
            "/index.html": "index.html",
            "/engine.js": "engine.js",
            "/app.js": "app.js",
            "/styles.css": "styles.css",
            "/symbol_games.html": "symbol_games.html",
            "/word_fill.html": "word_fill.html",
            "/mascot.png": "attached_assets/generated_images/mindtrace-elephant-mascot.png",
            "/mascot-logo.png": "attached_assets/generated_images/mindtrace-elephant-head-logo.png",
            "/mascot-front.png": "attached_assets/generated_images/mindtrace-elephant-front-minimal.png",
            "/mascot-side.png": "attached_assets/generated_images/mindtrace-elephant-side-minimal.png",
            "/mindtrace-mark.svg": "attached_assets/generated_images/mindtrace-m-elephant.svg",
        }

        EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
        MAX_BODY = 1_000_000          # 1 MB ceiling on any request body
        PBKDF2_ROUNDS = 120_000

        _lock = threading.Lock()


        # --------------------------------------------------------------- storage
        def _blank_db() -> dict:
            return {"users": {}, "tokens": {}, "byEmail": {}, "byCode": {}}


        def load_db() -> dict:
            DATA_DIR.mkdir(exist_ok=True)
            if not DB_PATH.exists():
                return _blank_db()
            try:
                data = json.loads(DB_PATH.read_text("utf-8"))
            except (json.JSONDecodeError, OSError):
                # A half-written file should not take the whole app down.
                return _blank_db()
            base = _blank_db()
            base.update(data)
            return base


        def save_db(db: dict) -> None:
            DATA_DIR.mkdir(exist_ok=True)
            # Write to a temp file then replace, so an interrupted write cannot
            # leave a truncated db.json behind.
            tmp = DB_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(db, indent=2), "utf-8")
            tmp.replace(DB_PATH)


        # --------------------------------------------------------------- helpers
        def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
            salt = salt or secrets.token_hex(16)
            digest = hashlib.pbkdf2_hmac(
                "sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ROUNDS
            )
            return salt, digest.hex()


        def verify_password(password: str, salt: str, expected: str) -> bool:
            _, attempt = hash_password(password, salt)
            return secrets.compare_digest(attempt, expected)


        def make_invite_code(db: dict) -> str:
            # Unambiguous alphabet: no O/0, no I/1, so codes can be read aloud.
            alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
            while True:
                code = "".join(secrets.choice(alphabet) for _ in range(6))
                if code not in db["byCode"]:
                    return code


        def date_key(value: str) -> date | None:
            try:
                return datetime.fromisoformat(str(value)[:10]).date()
            except ValueError:
                return None


        def current_streak(sessions: list) -> int:
            """Consecutive days up to today (or yesterday) with a check-in."""
            days = sorted({d for d in (date_key(s.get("date", "")) for s in sessions) if d})
            if not days:
                return 0
            today = date.today()
            if (today - days[-1]).days > 1:
                return 0
            run = 1
            for i in range(len(days) - 1, 0, -1):
                if (days[i] - days[i - 1]).days == 1:
                    run += 1
                else:
                    break
            return run


        def public_user(user: dict) -> dict:
            return {
                "id": user["id"],
                "email": user["email"],
                "name": user["name"],
                "birthYear": user.get("birthYear"),
                "theme": user.get("theme", "light"),
                "inviteCode": user["inviteCode"],
                "created": user["created"],
            }


        def friend_card(user: dict) -> dict:
            """What a friend is allowed to see. Streaks and attendance only."""
            sessions = user.get("sessions", [])
            days = sorted({d for d in (date_key(s.get("date", "")) for s in sessions) if d})
            return {
                "id": user["id"],
                "name": user["name"],
                "streak": current_streak(sessions),
                "sessions": len(sessions),
                "lastCheckIn": days[-1].isoformat() if days else None,
                "checkedInToday": bool(days) and days[-1] == date.today(),
            }


        def friends_payload(db: dict, user: dict) -> list:
            cards = []
            for fid in user.get("friends", []):
                friend = db["users"].get(fid)
                if friend:
                    cards.append(friend_card(friend))
            # Longest streak first, then most sessions.
            cards.sort(key=lambda c: (-c["streak"], -c["sessions"], c["name"].lower()))
            return cards


        # --------------------------------------------------------------- handler
        class MindTraceHandler(SimpleHTTPRequestHandler):
            server_version = "MindTrace"

            # ---------- plumbing ----------
            def send_json(self, payload: dict, status: int = 200) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def fail(self, status: int, message: str) -> None:
                self.send_json({"error": message}, status)

            def read_json(self) -> dict | None:
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                except ValueError:
                    return None
                if length <= 0 or length > MAX_BODY:
                    return None
                try:
                    return json.loads(self.rfile.read(length).decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    return None

            def auth_user(self, db: dict) -> dict | None:
                header = self.headers.get("Authorization", "")
                if not header.startswith("Bearer "):
                    return None
                user_id = db["tokens"].get(header[7:].strip())
                return db["users"].get(user_id) if user_id else None

            # ---------- routes ----------
            def do_GET(self):
                path = self.path.split("?", 1)[0]
                if path.startswith("/api/"):
                    self.handle_api("GET", path)
                    return
                filename = ALLOWED_FILES.get(path)
                if filename is None:
                    self.send_error(404, "Not found")
                    return
                target = ROOT / filename
                if not target.is_file():
                    self.send_error(404, "Not found")
                    return
                body = target.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", self.content_type(filename))
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                self.handle_api("POST", self.path.split("?", 1)[0])

            def do_PUT(self):
                self.handle_api("PUT", self.path.split("?", 1)[0])

            def do_DELETE(self):
                self.handle_api("DELETE", self.path.split("?", 1)[0])

            def handle_api(self, method: str, path: str):
                if not path.startswith("/api/"):
                    self.send_error(404, "Not found")
                    return
                body = self.read_json() if method in {"POST", "PUT", "DELETE"} else {}
                if body is None:
                    body = {}

                with _lock:
                    db = load_db()
                    try:
                        self.route(method, path, body, db)
                    except Exception as err:                      # noqa: BLE001
                        print(f"API error on {method} {path}: {err}", flush=True)
                        self.fail(500, "Something went wrong on the server.")

            def route(self, method: str, path: str, body: dict, db: dict):
                if method == "POST" and path == "/api/signup":
                    return self.signup(body, db)
                if method == "POST" and path == "/api/signin":
                    return self.signin(body, db)

                user = self.auth_user(db)
                if user is None:
                    return self.fail(401, "Please sign in again.")

                if method == "GET" and path == "/api/me":
                    return self.send_json({
                        "user": public_user(user),
                        "sessions": user.get("sessions", []),
                    })
                if method == "POST" and path == "/api/sessions":
                    return self.add_session(body, db, user)
                if method == "PUT" and path == "/api/profile":
                    return self.update_profile(body, db, user)
                if method == "GET" and path == "/api/friends":
                    return self.send_json({
                        "friends": friends_payload(db, user),
                        "inviteCode": user["inviteCode"],
                    })
                if method == "POST" and path == "/api/friends":
                    return self.add_friend(body, db, user)
                if method == "DELETE" and path == "/api/friends":
                    return self.remove_friend(body, db, user)

                return self.fail(404, "Unknown request.")

            # ---------- handlers ----------
            def signup(self, body: dict, db: dict):
                email = str(body.get("email", "")).strip().lower()
                password = str(body.get("password", ""))
                name = str(body.get("name", "")).strip()

                if not EMAIL_RE.match(email):
                    return self.fail(400, "Please enter a valid email address.")
                if len(password) < 6:
                    return self.fail(400, "Please choose a password of at least 6 characters.")
                if not name:
                    return self.fail(400, "Please enter your first name.")
                if email in db["byEmail"]:
                    return self.fail(409, "There is already an account with that email. Try signing in.")

                salt, digest = hash_password(password)
                code = make_invite_code(db)
                user_id = "u" + secrets.token_hex(8)
                birth_year = body.get("birthYear")
                try:
                    birth_year = int(birth_year) if birth_year else None
                except (TypeError, ValueError):
                    birth_year = None

                user = {
                    "id": user_id,
                    "email": email,
                    "name": name[:40],
                    "birthYear": birth_year,
                    "salt": salt,
                    "hash": digest,
                    "inviteCode": code,
                    "theme": "light",
                    "created": date.today().isoformat(),
                    "sessions": [],
                    "friends": [],
                }
                db["users"][user_id] = user
                db["byEmail"][email] = user_id
                db["byCode"][code] = user_id

                token = secrets.token_urlsafe(32)
                db["tokens"][token] = user_id
                save_db(db)
                return self.send_json({"token": token, "user": public_user(user), "sessions": []})

            def signin(self, body: dict, db: dict):
                email = str(body.get("email", "")).strip().lower()
                password = str(body.get("password", ""))
                user_id = db["byEmail"].get(email)
                user = db["users"].get(user_id) if user_id else None

                if not user or not verify_password(password, user["salt"], user["hash"]):
                    # Same message either way, so this cannot be used to discover
                    # which email addresses have accounts.
                    return self.fail(401, "That email and password do not match an account.")

                token = secrets.token_urlsafe(32)
                db["tokens"][token] = user["id"]
                save_db(db)
                return self.send_json({
                    "token": token,
                    "user": public_user(user),
                    "sessions": user.get("sessions", []),
                })

            def add_session(self, body: dict, db: dict, user: dict):
                session = body.get("session")
                if not isinstance(session, dict):
                    return self.fail(400, "No session data received.")

                sessions = user.setdefault("sessions", [])
                today = date.today().isoformat()
                session.setdefault("date", today)

                # One battery per person per day. Replacing rather than appending
                # keeps session numbers meaningful.
                existing = next((s for s in sessions if s.get("date") == session["date"]), None)
                if existing:
                    session["n"] = existing.get("n", len(sessions))
                    sessions[sessions.index(existing)] = session
                else:
                    session["n"] = len(sessions) + 1
                    sessions.append(session)

                sessions.sort(key=lambda s: str(s.get("date", "")))
                for index, item in enumerate(sessions, start=1):
                    item["n"] = index

                save_db(db)
                return self.send_json({"ok": True, "sessions": sessions})

            def update_profile(self, body: dict, db: dict, user: dict):
                if "name" in body:
                    name = str(body["name"]).strip()
                    if name:
                        user["name"] = name[:40]
                if "birthYear" in body:
                    try:
                        user["birthYear"] = int(body["birthYear"]) if body["birthYear"] else None
                    except (TypeError, ValueError):
                        pass
                if "theme" in body and body["theme"] in {"light", "dark"}:
                    user["theme"] = body["theme"]
                save_db(db)
                return self.send_json({"user": public_user(user)})

            def add_friend(self, body: dict, db: dict, user: dict):
                code = str(body.get("code", "")).strip().upper()
                if not code:
                    return self.fail(400, "Please enter an invite code.")
                if code == user["inviteCode"]:
                    return self.fail(400, "That is your own code. Share it with a friend instead.")

                friend_id = db["byCode"].get(code)
                friend = db["users"].get(friend_id) if friend_id else None
                if not friend:
                    return self.fail(404, "No one was found with that code. Check the letters and try again.")

                # Mutual, like Apple Fitness. Sharing a streak one way only is odd.
                if friend["id"] not in user.setdefault("friends", []):
                    user["friends"].append(friend["id"])
                if user["id"] not in friend.setdefault("friends", []):
                    friend["friends"].append(user["id"])

                save_db(db)
                return self.send_json({"ok": True, "friends": friends_payload(db, user)})

            def remove_friend(self, body: dict, db: dict, user: dict):
                friend_id = str(body.get("friendId", ""))
                friend = db["users"].get(friend_id)
                if friend_id in user.get("friends", []):
                    user["friends"].remove(friend_id)
                if friend and user["id"] in friend.get("friends", []):
                    friend["friends"].remove(user["id"])
                save_db(db)
                return self.send_json({"ok": True, "friends": friends_payload(db, user)})

            # ---------- misc ----------
            @staticmethod
            def content_type(filename: str) -> str:
                if filename.endswith(".svg"):
                    return "image/svg+xml"
                if filename.endswith(".png"):
                    return "image/png"
                if filename.endswith(".css"):
                    return "text/css; charset=utf-8"
                if filename.endswith(".js"):
                    return "text/javascript; charset=utf-8"
                return "text/html; charset=utf-8"

            def log_message(self, fmt, *args):
                if args and str(args[1]).startswith(("4", "5")):
                    super().log_message(fmt, *args)


        if __name__ == "__main__":
            server = ThreadingHTTPServer(("0.0.0.0", PORT), MindTraceHandler)
            print(f"MindTrace listening on port {PORT}", flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                server.server_close()