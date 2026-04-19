"""
Database models and initialization for the Expense Management App.
Uses SQLite for lightweight, file-based persistence.
"""
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'expenses.db')


def get_db_connection():
    """Get a connection to the SQLite database."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row  # Return rows as dicts
    conn.execute("PRAGMA journal_mode=WAL")  # Better concurrent read performance
    return conn


def init_db():
    """Initialize the database schema. Creates tables if they don't exist."""
    # Ensure the data directory exists
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            data_valuta TEXT NOT NULL,
            operazione TEXT NOT NULL,
            conto_carta TEXT DEFAULT '',
            categoria TEXT DEFAULT '',
            valuta TEXT DEFAULT 'EUR',
            importo REAL NOT NULL,
            is_excluded INTEGER DEFAULT 0,
            is_neutral INTEGER DEFAULT 0,
            is_pending INTEGER DEFAULT 0,
            is_ignored_rimborso INTEGER DEFAULT 0,
            hash_id TEXT UNIQUE NOT NULL
        )
    """)

    # Migration: add is_neutral column if it doesn't exist (existing DBs)
    try:
        cursor.execute("ALTER TABLE expenses ADD COLUMN is_neutral INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass  # Column already exists

    # Migration: add is_pending column if it doesn't exist
    try:
        cursor.execute("ALTER TABLE expenses ADD COLUMN is_pending INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass  # Column already exists

    # One-time backfill: flag old "Pagamento Pos" entries as pending
    # (only touches rows that need it; no-op once all are fixed)
    cursor.execute("""
        UPDATE expenses
        SET is_pending = 1
        WHERE LOWER(TRIM(operazione)) LIKE 'pagamento pos%'
          AND is_pending = 0
    """)

    # Migration: add is_ignored_rimborso column if it doesn't exist
    try:
        cursor.execute("ALTER TABLE expenses ADD COLUMN is_ignored_rimborso INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass  # Column already exists

    # Index for faster date-range queries and search
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_expenses_data
        ON expenses(data_valuta DESC)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_expenses_hash
        ON expenses(hash_id)
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS monthly_status (
            month INTEGER NOT NULL,
            year  INTEGER NOT NULL,
            is_paid INTEGER DEFAULT 0,
            PRIMARY KEY (month, year)
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS neutral_keywords (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            keyword TEXT UNIQUE NOT NULL
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS rimborso_mittenti (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            operazione  TEXT    NOT NULL UNIQUE,
            keyword_id  INTEGER,
            tolleranza  REAL    DEFAULT 5.0,
            attivo      INTEGER DEFAULT 1
        )
    """)

    # Migration: reset is_neutral=0 for any expense that matches an active rimborso
    # mittente pattern but was previously auto-neutralized by the old keyword-link logic.
    # Only reset entries that the user has NOT explicitly confirmed (they don't have
    # is_ignored_rimborso=1). Confirmed entries stay neutral; non-confirmed entries
    # become visible again in the popup flow.
    mittenti = cursor.execute(
        "SELECT operazione FROM rimborso_mittenti WHERE attivo = 1"
    ).fetchall()
    for m in mittenti:
        pattern = f"%{m[0].lower()}%"
        cursor.execute("""
            UPDATE expenses
            SET is_neutral = 0
            WHERE is_ignored_rimborso = 0
              AND is_neutral = 1
              AND LOWER(TRIM(operazione)) LIKE ?
        """, (pattern,))

    conn.commit()
    conn.close()
