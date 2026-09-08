import uuid
from datetime import datetime
from sqlalchemy import Boolean, Column, String, Integer, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()), index=True)
    display_name = Column(String, index=True)
    personal_meeting_id = Column(String, unique=True, index=True, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    meetings = relationship("Meeting", back_populates="host")


class Meeting(Base):
    __tablename__ = "meetings"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()), index=True)
    meeting_id = Column(String, unique=True, index=True) # 10-digit shareable ID
    title = Column(String)
    description = Column(String, nullable=True)
    host_id = Column(String, ForeignKey("users.id"))
    scheduled_at = Column(DateTime(timezone=True), nullable=True)
    duration_minutes = Column(Integer, nullable=True)
    status = Column(String, default="upcoming") # 'upcoming', 'active', 'ended'
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    ended_at = Column(DateTime(timezone=True), nullable=True)

    host = relationship("User", back_populates="meetings")
    participants = relationship("Participant", back_populates="meeting")


class Participant(Base):
    __tablename__ = "participants"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()), index=True)
    meeting_id = Column(String, ForeignKey("meetings.id"))
    user_id = Column(String, ForeignKey("users.id"), nullable=True, index=True)
    display_name = Column(String)
    role = Column(String, default="guest") # 'host', 'guest'
    audio_enabled = Column(Boolean, default=True, nullable=False)
    video_enabled = Column(Boolean, default=True, nullable=False)
    is_screen_sharing = Column(Boolean, default=False, nullable=False)
    joined_at = Column(DateTime(timezone=True), server_default=func.now())
    left_at = Column(DateTime(timezone=True), nullable=True)

    meeting = relationship("Meeting", back_populates="participants")


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()), index=True)
    meeting_id = Column(String, ForeignKey("meetings.id"), index=True)
    participant_id = Column(String, ForeignKey("participants.id"), index=True)
    content = Column(String)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    meeting = relationship("Meeting")
    participant = relationship("Participant")
