from pydantic import BaseModel, ConfigDict, Field
from typing import Optional
from datetime import datetime

class UserBase(BaseModel):
    display_name: str = Field(min_length=1, max_length=80)

class UserCreate(UserBase):
    pass

class UserResponse(UserBase):
    id: str
    personal_meeting_id: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class MeetingBase(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    scheduled_at: Optional[datetime] = None
    duration_minutes: Optional[int] = Field(default=None, ge=1, le=1440)
    status: Optional[str] = "upcoming"

class MeetingCreate(MeetingBase):
    host_id: str

class MeetingUpdate(BaseModel):
    """Safe, host-editable fields only — host reassignment and status changes
    are deliberately absent. `requester_id` identifies the editing app user;
    `exclude_unset` semantics keep unprovided fields untouched."""
    requester_id: str
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    scheduled_at: Optional[datetime] = None
    duration_minutes: Optional[int] = Field(default=None, ge=1, le=1440)

class MeetingResponse(MeetingBase):
    id: str
    meeting_id: str
    host_id: str
    created_at: datetime
    ended_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class ParticipantBase(BaseModel):
    display_name: str = Field(min_length=1, max_length=80)
    role: Optional[str] = "guest"

class ParticipantCreate(ParticipantBase):
    user_id: Optional[str] = None

class ParticipantResponse(ParticipantBase):
    id: str
    meeting_id: str
    user_id: Optional[str] = None
    joined_at: datetime
    left_at: Optional[datetime] = None
    audio_enabled: bool = True
    video_enabled: bool = True
    is_screen_sharing: bool = False

    model_config = ConfigDict(from_attributes=True)

class ParticipantLeave(BaseModel):
    participant_id: str


class ChatMessageResponse(BaseModel):
    # Canonical chat shape — identical field names to the chat_message
    # WebSocket event so the frontend merges realtime and history messages
    # by id without translation.
    id: str
    sender_id: str
    sender_name: str
    content: str
    timestamp: datetime


class HostActionRequest(BaseModel):
    participant_id: str


class AIAssistantResponse(BaseModel):
    mode: str
    summary: str
    key_points: list[str]
    action_items: list[str]
    questions: list[str]
