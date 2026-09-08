from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from sqlalchemy.exc import IntegrityError
import secrets
from datetime import datetime, timezone

import models
import schemas
from database import get_db
from utils.websockets import manager

router = APIRouter(prefix="/api/meetings", tags=["meetings"])

MEETING_ID_MIN = 1_000_000_000
MEETING_ID_MAX = 9_999_999_999
ID_GENERATION_ATTEMPTS = 20


def generate_meeting_id() -> str:
    """Generate a cryptographically random 10-digit meeting ID."""
    return str(secrets.randbelow(MEETING_ID_MAX - MEETING_ID_MIN + 1) + MEETING_ID_MIN)


def generate_personal_meeting_id() -> str:
    return generate_meeting_id()


def ensure_personal_meeting_id(user: models.User, db: Session) -> str:
    if user.personal_meeting_id:
        return user.personal_meeting_id
    for _ in range(ID_GENERATION_ATTEMPTS):
        candidate = generate_personal_meeting_id()
        if not db.query(models.User).filter(models.User.personal_meeting_id == candidate).first() and not db.query(models.Meeting).filter(models.Meeting.meeting_id == candidate).first():
            user.personal_meeting_id = candidate
            return candidate
    raise HTTPException(status_code=503, detail="Unable to allocate a Personal Meeting ID")

@router.post("", response_model=schemas.MeetingResponse)
def create_meeting(meeting: schemas.MeetingCreate, db: Session = Depends(get_db)):
    host = db.query(models.User).filter(models.User.id == meeting.host_id).first()
    if not host:
        raise HTTPException(status_code=401, detail="Host user must be registered first")
    ensure_personal_meeting_id(host, db)

    payload = meeting.model_dump(exclude={"status"})
    payload["status"] = "upcoming" if meeting.scheduled_at and meeting.scheduled_at > datetime.now(timezone.utc) else "active"
    for _ in range(ID_GENERATION_ATTEMPTS):
        new_meeting = models.Meeting(**payload, meeting_id=generate_meeting_id())
        db.add(new_meeting)
        try:
            db.commit()
            db.refresh(new_meeting)
            return new_meeting
        except IntegrityError:
            db.rollback()
    raise HTTPException(status_code=503, detail="Unable to allocate a unique Meeting ID")

@router.get("", response_model=List[schemas.MeetingResponse])
def get_meetings(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    # Newest first: the dashboard and Meetings page surface the most recent
    # activity, and the limit must never hide freshly created meetings
    # behind months of history.
    meetings = (
        db.query(models.Meeting)
        .order_by(models.Meeting.created_at.desc(), models.Meeting.id.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )
    return meetings

@router.get("/{meeting_id}", response_model=schemas.MeetingResponse)
def get_meeting(meeting_id: str, db: Session = Depends(get_db)):
    meeting = db.query(models.Meeting).filter(models.Meeting.meeting_id == meeting_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return meeting

@router.post("/{meeting_id}/join", response_model=schemas.ParticipantResponse)
def join_meeting(meeting_id: str, participant: schemas.ParticipantCreate, db: Session = Depends(get_db)):
    meeting = db.query(models.Meeting).filter(models.Meeting.meeting_id == meeting_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting.status == "ended":
        raise HTTPException(status_code=410, detail="This meeting has ended")
    if not participant.user_id:
        raise HTTPException(status_code=422, detail="user_id is required to join a meeting")

    user = db.query(models.User).filter(models.User.id == participant.user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User session is not registered")

    existing = db.query(models.Participant).filter(
        models.Participant.meeting_id == meeting.id,
        models.Participant.user_id == user.id,
        models.Participant.left_at.is_(None),
    ).first()
    if existing:
        return existing

    new_participant = models.Participant(
        meeting_id=meeting.id,
        user_id=user.id,
        display_name=participant.display_name,
        role="host" if user.id == meeting.host_id else "guest",
    )
    db.add(new_participant)
    db.commit()
    db.refresh(new_participant)
    return new_participant


@router.get("/{meeting_id}/participants", response_model=List[schemas.ParticipantResponse])
def get_participants(meeting_id: str, db: Session = Depends(get_db)):
    meeting = db.query(models.Meeting).filter(models.Meeting.meeting_id == meeting_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return db.query(models.Participant).filter(
        models.Participant.meeting_id == meeting.id,
        models.Participant.left_at.is_(None),
    ).order_by(models.Participant.joined_at).all()


@router.get("/{meeting_id}/chat", response_model=List[schemas.ChatMessageResponse])
def get_chat(meeting_id: str, db: Session = Depends(get_db)):
    meeting = db.query(models.Meeting).filter(models.Meeting.meeting_id == meeting_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    messages = db.query(models.ChatMessage).filter(
        models.ChatMessage.meeting_id == meeting.id
    ).order_by(models.ChatMessage.created_at.desc()).limit(100).all()
    return [
        schemas.ChatMessageResponse(
            id=message.id,
            sender_id=message.participant_id,
            sender_name=message.participant.display_name,
            content=message.content,
            timestamp=message.created_at,
        )
        for message in reversed(messages)
    ]

@router.post("/{meeting_id}/leave")
def leave_meeting(meeting_id: str, leave_req: schemas.ParticipantLeave, db: Session = Depends(get_db)):
    meeting = db.query(models.Meeting).filter(models.Meeting.meeting_id == meeting_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")

    participant = db.query(models.Participant).filter(
        models.Participant.id == leave_req.participant_id,
        models.Participant.meeting_id == meeting.id
    ).first()

    if not participant:
        raise HTTPException(status_code=404, detail="Participant not found in this meeting")

    if participant.left_at is not None:
        return {"status": "success", "message": "Participant already left the meeting"}

    participant.left_at = datetime.now(timezone.utc)
    db.commit()
    return {"status": "success", "message": "Participant left the meeting"}


def get_host_and_participant(meeting_id: str, requester_id: str, db: Session):
    meeting = db.query(models.Meeting).filter(models.Meeting.meeting_id == meeting_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    requester = db.query(models.Participant).filter(
        models.Participant.id == requester_id,
        models.Participant.meeting_id == meeting.id,
        models.Participant.left_at.is_(None),
    ).first()
    if not requester:
        raise HTTPException(status_code=403, detail="Participant is not in this meeting")
    if requester.role != "host":
        raise HTTPException(status_code=403, detail="Host permissions required")
    return meeting, requester


@router.patch("/{meeting_id}", response_model=schemas.MeetingResponse)
def update_meeting(meeting_id: str, update: schemas.MeetingUpdate, db: Session = Depends(get_db)):
    meeting = db.query(models.Meeting).filter(models.Meeting.meeting_id == meeting_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting.status == "ended":
        raise HTTPException(status_code=410, detail="This meeting has ended")
    # Ownership is checked against the requesting app user — the host — never
    # trusted from the payload's meeting fields. Host reassignment is not an
    # editable field at all.
    if update.requester_id != meeting.host_id:
        raise HTTPException(status_code=403, detail="Only the meeting host can edit this meeting")
    changes = update.model_dump(exclude_unset=True, exclude={"requester_id"})
    if not changes:
        return meeting
    for field, value in changes.items():
        setattr(meeting, field, value)
    db.commit()
    db.refresh(meeting)
    return meeting


@router.post("/{meeting_id}/mute-all")
def mute_all(meeting_id: str, request: schemas.HostActionRequest, db: Session = Depends(get_db)):
    meeting, _ = get_host_and_participant(meeting_id, request.participant_id, db)
    return {"status": "success", "meeting_id": meeting.meeting_id, "initiated_by": request.participant_id}


@router.post("/{meeting_id}/remove-participant")
def remove_participant(meeting_id: str, request: schemas.HostActionRequest, target_id: str, db: Session = Depends(get_db)):
    meeting, _ = get_host_and_participant(meeting_id, request.participant_id, db)
    target = db.query(models.Participant).filter(
        models.Participant.id == target_id,
        models.Participant.meeting_id == meeting.id,
        models.Participant.left_at.is_(None),
    ).first()
    if not target:
        raise HTTPException(status_code=404, detail="Participant not found in this meeting")
    target.left_at = datetime.now(timezone.utc)
    db.commit()
    # Keep the in-memory revocation in sync with the WS path so a removed id
    # cannot reconnect through either removal route. The manager keys on the
    # public meeting_id, exactly like the WebSocket layer.
    manager.mark_removed(meeting.meeting_id, target.id)
    return {"status": "success", "participant_id": target.id}


@router.post("/{meeting_id}/end")
def end_meeting(meeting_id: str, request: schemas.HostActionRequest, db: Session = Depends(get_db)):
    meeting, _ = get_host_and_participant(meeting_id, request.participant_id, db)
    meeting.status = "ended"
    meeting.ended_at = datetime.now(timezone.utc)
    db.commit()
    return {"status": "success", "meeting_id": meeting.meeting_id}


@router.post("/{meeting_id}/ai/summary", response_model=schemas.AIAssistantResponse)
def meeting_summary(meeting_id: str, db: Session = Depends(get_db)):
    meeting = db.query(models.Meeting).filter(models.Meeting.meeting_id == meeting_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    message_count = db.query(models.ChatMessage).filter(models.ChatMessage.meeting_id == meeting.id).count()
    return schemas.AIAssistantResponse(
        mode="demo",
        summary=f"Meeting assistant is in demo mode. {message_count} chat messages are available for {meeting.title}.",
        key_points=["Review the conversation and participant updates before sharing a final summary."],
        action_items=["Capture owners and due dates from the meeting discussion."],
        questions=["Would you like to connect an AI provider for transcript-based summaries?"],
    )
