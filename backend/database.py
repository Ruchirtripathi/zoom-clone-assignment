import os
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy import event, inspect, text

_db_env = os.getenv("DATABASE_PATH")
DATABASE_PATH = Path(_db_env) if _db_env else Path(__file__).resolve().parent / "zoom.db"
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DATABASE_PATH.as_posix()}"

# connect_args={"check_same_thread": False} is needed only for SQLite
engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)


@event.listens_for(engine, "connect")
def enable_sqlite_foreign_keys(dbapi_connection, _connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def ensure_compatibility_schema():
    """Add the small set of columns needed by existing SQLite databases."""
    inspector = inspect(engine)
    table_columns = {
        table: {column["name"] for column in inspector.get_columns(table)}
        for table in ("users", "meetings", "participants")
        if inspector.has_table(table)
    }
    additions = {
        "users": {"personal_meeting_id": "VARCHAR(10)"},
        "meetings": {"ended_at": "DATETIME"},
        "participants": {
            "user_id": "VARCHAR(255)",
            "audio_enabled": "BOOLEAN NOT NULL DEFAULT 1",
            "video_enabled": "BOOLEAN NOT NULL DEFAULT 1",
            "is_screen_sharing": "BOOLEAN NOT NULL DEFAULT 0",
        },
    }
    with engine.begin() as connection:
        for table, columns in additions.items():
            for column, definition in columns.items():
                if table in table_columns and column not in table_columns[table]:
                    connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {definition}"))
        if "users" in table_columns:
            connection.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_personal_meeting_id "
                "ON users (personal_meeting_id) WHERE personal_meeting_id IS NOT NULL"
            ))

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
