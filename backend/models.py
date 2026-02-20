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
            hash_id TEXT UNIQUE NOT NULL
        )
    """)

    # Migration: add is_neutral column if it doesn't exist (existing DBs)
    try:
        cursor.execute("ALTER TABLE expenses ADD COLUMN is_neutral INTEGER DEFAULT 0")
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
        CREATE TABLE IF NOT EXISTS rimborso_settings (
            id INTEGER PRIMARY KEY,
            keyword_id INTEGER,
            tolleranza REAL DEFAULT 5.0,
            attivo INTEGER DEFAULT 1
        )
    """)

    # Ensure default row exists
    cursor.execute("""
        INSERT OR IGNORE INTO rimborso_settings (id, keyword_id, tolleranza, attivo)
        VALUES (1, NULL, 5.0, 1)
    """)

    conn.commit()
    conn.close()
