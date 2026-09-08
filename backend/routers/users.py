from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

import models
import schemas
from database import get_db
from routers.meetings import ensure_personal_meeting_id

router = APIRouter(prefix="/api/users", tags=["users"])


class UserIdentityRequest(schemas.UserCreate):
    id: str


@router.post("/me", response_model=schemas.UserResponse)
def register_user(identity: UserIdentityRequest, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.id == identity.id).first()
    if not user:
        user = models.User(id=identity.id, display_name=identity.display_name)
        db.add(user)
    else:
        user.display_name = identity.display_name
    ensure_personal_meeting_id(user, db)
    db.commit()
    db.refresh(user)
    return user


@router.get("/{user_id}", response_model=schemas.UserResponse)
def get_user(user_id: str, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="User not found")
    ensure_personal_meeting_id(user, db)
    db.commit()
    db.refresh(user)
    return user


@router.post("/{user_id}/personal-meeting", response_model=schemas.MeetingResponse)
def start_personal_meeting(user_id: str, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="User not found")
    pmi = ensure_personal_meeting_id(user, db)
    meeting = db.query(models.Meeting).filter(models.Meeting.meeting_id == pmi).first()
    if meeting:
        if meeting.host_id != user.id:
            from fastapi import HTTPException
            raise HTTPException(status_code=409, detail="Personal Meeting ID is already in use")
        meeting.status = "active"
        meeting.ended_at = None
        db.commit()
        db.refresh(meeting)
        return meeting
    meeting = models.Meeting(
        meeting_id=pmi,
        title=f"{user.display_name}'s Personal Meeting Room",
        host_id=user.id,
        status="active",
    )
    db.add(meeting)
    db.commit()
    db.refresh(meeting)
    return meeting