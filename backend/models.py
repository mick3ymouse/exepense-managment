"""
Database schema and versioned migrations for the Expense Management App.
Uses SQLite with WAL mode for lightweight, file-based persistence.
"""
import os
import sqlite3

DB_PATH = os.environ.get(
    "EXPENSES_DB_PATH",
    os.path.join(os.path.dirname(__file__), "..", "data", "expenses.db"),
)


# ── Connection ────────────────────────────────────────────────────

def get_db_connection() -> sqlite3.Connection:
    """Return a connection to the SQLite database with dict-like rows."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


# ── Schema ────────────────────────────────────────────────────────

_TABLES = [
    """
    CREATE TABLE IF NOT EXISTS expenses (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        data_valuta         TEXT    NOT NULL,
        operazione          TEXT    NOT NULL,
        conto_carta         TEXT    DEFAULT '',
        categoria           TEXT    DEFAULT '',
        valuta              TEXT    DEFAULT 'EUR',
        importo             REAL    NOT NULL,
        is_excluded         INTEGER DEFAULT 0,
        is_neutral          INTEGER DEFAULT 0,
        is_pending          INTEGER DEFAULT 0,
        is_ignored_rimborso INTEGER DEFAULT 0,
        hash_id             TEXT    UNIQUE NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS monthly_status (
        month   INTEGER NOT NULL,
        year    INTEGER NOT NULL,
        is_paid INTEGER DEFAULT 0,
        PRIMARY KEY (month, year)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS neutral_keywords (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        keyword TEXT    UNIQUE NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS rimborso_mittenti (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        operazione TEXT    NOT NULL UNIQUE,
        keyword_id INTEGER,
        tolleranza REAL   DEFAULT 5.0,
        attivo     INTEGER DEFAULT 1
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
    )
    """,
]

_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_expenses_data ON expenses(data_valuta DESC)",
    "CREATE INDEX IF NOT EXISTS idx_expenses_hash ON expenses(hash_id)",
]


# ── Versioned Migrations ─────────────────────────────────────────
# Each entry is (version_number, description, list_of_SQL_statements).
# Migrations run exactly ONCE, in order, and are tracked in schema_version.

_MIGRATIONS: list[tuple[int, str, list[str]]] = [
    # v1 — add columns that may be missing on older databases
    (1, "add is_neutral, is_pending, is_ignored_rimborso columns", [
        "ALTER TABLE expenses ADD COLUMN is_neutral          INTEGER DEFAULT 0",
        "ALTER TABLE expenses ADD COLUMN is_pending          INTEGER DEFAULT 0",
        "ALTER TABLE expenses ADD COLUMN is_ignored_rimborso INTEGER DEFAULT 0",
    ]),

    # v2 — backfill: flag old "Pagamento Pos" entries as pending
    (2, "backfill is_pending for pagamento pos entries", [
        """
        UPDATE expenses
        SET is_pending = 1
        WHERE LOWER(TRIM(operazione)) LIKE 'pagamento pos%'
          AND is_pending = 0
        """,
    ]),

    # v3 — one-time fix: reset is_neutral for rimborso mittenti entries
    #       that were previously auto-neutralized by the old keyword-link logic
    (3, "reset is_neutral for rimborso mittenti entries", [
        """
        UPDATE expenses
        SET is_neutral = 0
        WHERE is_ignored_rimborso = 0
          AND is_neutral = 1
          AND id IN (
              SELECT e.id
              FROM expenses e, rimborso_mittenti rm
              WHERE rm.attivo = 1
                AND LOWER(TRIM(e.operazione)) LIKE '%' || LOWER(rm.operazione) || '%'
          )
        """,
    ]),
    # v4 — backfill: flag old "Pagamento Tramite Pos" entries as pending
    (4, "backfill is_pending for pagamento tramite pos entries", [
        """
        UPDATE expenses
        SET is_pending = 1
        WHERE LOWER(TRIM(operazione)) LIKE 'pagamento tramite pos%'
          AND is_pending = 0
        """,
    ]),
    # v5 — cleanup: remove orphaned "Pagamento (Tramite) Pos" entries when
    #       a finalised counterpart with the same amount and close date exists
    (5, "delete orphaned pagamento pos entries with finalized counterpart", [
        """
        DELETE FROM expenses
        WHERE id IN (
            SELECT p.id
            FROM expenses p
            JOIN expenses f ON f.is_pending = 0
                           AND f.importo = p.importo
                           AND f.data_valuta BETWEEN date(p.data_valuta, '-7 days')
                                                 AND date(p.data_valuta, '+7 days')
                           AND f.id != p.id
                           AND LOWER(TRIM(f.operazione)) NOT LIKE 'pagamento pos%'
                           AND LOWER(TRIM(f.operazione)) NOT LIKE 'pagamento tramite pos%'
            WHERE (LOWER(TRIM(p.operazione)) LIKE 'pagamento pos%'
                OR LOWER(TRIM(p.operazione)) LIKE 'pagamento tramite pos%')
        )
        """,
    ]),
]


# ── Initialisation ────────────────────────────────────────────────

def _get_schema_version(cursor: sqlite3.Cursor) -> int:
    """Return the current schema version, or 0 if the table doesn't exist yet."""
    try:
        row = cursor.execute("SELECT MAX(version) FROM schema_version").fetchone()
        return row[0] or 0
    except sqlite3.OperationalError:
        return 0


def _run_migrations(cursor: sqlite3.Cursor, current_version: int) -> None:
    """Apply all pending migrations in order."""
    for version, description, statements in _MIGRATIONS:
        if version <= current_version:
            continue
        for sql in statements:
            try:
                cursor.execute(sql)
            except sqlite3.OperationalError:
                # Tolerate "duplicate column" or similar idempotent failures
                pass
        cursor.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))


def init_db() -> None:
    """Initialise database: create tables, indexes, and run pending migrations."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    conn = get_db_connection()
    cursor = conn.cursor()

    current_version = _get_schema_version(cursor)

    for ddl in _TABLES:
        cursor.execute(ddl)
    for ddl in _INDEXES:
        cursor.execute(ddl)

    _run_migrations(cursor, current_version)

    conn.commit()
    conn.close()
