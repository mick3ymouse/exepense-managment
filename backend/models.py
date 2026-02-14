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
            hash_id TEXT UNIQUE NOT NULL
        )
    """)

    # Index for faster date-range queries and search
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_expenses_data
        ON expenses(data_valuta DESC)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_expenses_hash
        ON expenses(hash_id)
    """)

    conn.commit()
    conn.close()
