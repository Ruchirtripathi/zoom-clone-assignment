import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from database import engine, Base, ensure_compatibility_schema
import models
from routers import meetings, users, ws

# Create database tables
Base.metadata.create_all(bind=engine)
ensure_compatibility_schema()

app = FastAPI(title="Zoom Clone API")

cors_env = os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
allowed_origins = [origin.strip() for origin in cors_env.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(meetings.router)
app.include_router(users.router)
app.include_router(ws.router)

@app.get("/health")
def health():
    """Deployment liveness probe: process alive + SQLite reachable.

    No auth, no meeting membership, no environment or schema details — a
    bare SELECT 1 is the cheapest honest check that the database file (and
    the volume it lives on) is actually mountable.
    """
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse(status_code=503, content={"status": "error", "database": "unreachable"})
    return {"status": "ok", "database": "ok"}


@app.get("/api/health")
def health_check():
    return {"status": "ok", "message": "API is up and running"}
