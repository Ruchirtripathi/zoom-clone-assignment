import json
import logging
import time
from datetime import datetime, timezone
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
from database import SessionLocal
import models
from utils.websockets import manager
from utils.events import ANSWER_EVENT, AUDIO_STATE_EVENT, ECHO_EVENT, EVENT_TYPES, HOST_EVENT_TYPES, ICE_CANDIDATE_EVENT, OFFER_EVENT, PING_EVENT, PONG_EVENT, TEST_EVENT_TYPES, VIDEO_STATE_EVENT, validate_envelope

router = APIRouter(prefix="/api/ws/meetings", tags=["websockets"])
logger = logging.getLogger("meetspace.websocket")

# Chat messages are capped so a single client cannot flood sockets or the
# chat_messages table with an oversized payload.
CHAT_MESSAGE_MAX_LENGTH = 2000

# Reactions are ephemeral UI events, but still validated: only the fixed set
# the picker offers is accepted, and a single connection may emit at most
# REACTION_RATE_LIMIT reactions per rolling second (in-memory, per
# connection — no Redis by design).
ALLOWED_REACTIONS = {"👍", "❤️", "😂", "👏", "🎉", "😮", "😢", "👎"}
REACTION_RATE_LIMIT = 5
REACTION_RATE_WINDOW_SECONDS = 1.0

ERROR_MESSAGES = {
    "MEETING_NOT_FOUND": "Meeting not found.",
    "NOT_AUTHORIZED": "Participant is not authorized for this meeting.",
    "INVALID_MESSAGE": "Invalid WebSocket message.",
    "UNKNOWN_MESSAGE_TYPE": "Unknown WebSocket message type.",
    "INVALID_SIGNALING_MESSAGE": "Invalid WebRTC signaling message.",
    "TARGET_NOT_CONNECTED": "The target participant is not connected.",
    "SCREEN_SHARE_ACTIVE": "Someone else is currently sharing their screen.",
    "INVALID_MEDIA_STATE": "Unable to perform this action.",
    "INVALID_CHAT_MESSAGE": "Message cannot be empty.",
    "CHAT_MESSAGE_TOO_LONG": "Message is too long.",
    "INVALID_REACTION": "That reaction is not supported.",
    "FORBIDDEN": "Only the host can perform this action.",
    "INVALID_TARGET": "That participant is not in this meeting.",
    "CANNOT_REMOVE_SELF": "The host cannot remove themselves. End the meeting or leave instead.",
}


async def send_error(websocket: WebSocket, code: str):
    await websocket.send_json({
        "type": "error",
        "code": code,
        "message": ERROR_MESSAGES[code],
    })


def participant_payload(participant: models.Participant) -> dict:
    return {
        "participant_id": participant.id,
        "name": participant.display_name,
        "role": participant.role,
        "audio_enabled": participant.audio_enabled,
        "video_enabled": participant.video_enabled,
        "is_screen_sharing": participant.is_screen_sharing,
    }


def active_room_participants(db: Session, meeting_id: str) -> list[dict]:
    participant_ids = manager.connected_participant_ids(meeting_id)
    if not participant_ids:
        return []
    participants = db.query(models.Participant).filter(
        models.Participant.id.in_(participant_ids),
        models.Participant.left_at.is_(None),
    ).all()
    by_id = {participant.id: participant for participant in participants}
    return [participant_payload(by_id[participant_id]) for participant_id in participant_ids if participant_id in by_id]

@router.websocket("/{meeting_id}")
async def websocket_endpoint(websocket: WebSocket, meeting_id: str, participant_id: str):
    await websocket.accept()
    db: Session = SessionLocal()
    meeting = db.query(models.Meeting).filter(models.Meeting.meeting_id == meeting_id).first()
    participant = db.query(models.Participant).filter(
        models.Participant.id == participant_id,
        models.Participant.meeting_id == meeting.id if meeting else False,
    ).first() if meeting else None
    if not meeting or not participant or meeting.status == "ended":
        await send_error(websocket, "MEETING_NOT_FOUND" if not meeting else "NOT_AUTHORIZED")
        db.close()
        await websocket.close(code=1008, reason="Meeting membership is required")
        return

    # A removed participant must not slip back in through the left_at revive
    # below (which exists for refresh-mid-meeting). Their stale id is
    # rejected; a fresh join flow creates a new participant row.
    if manager.is_removed(meeting_id, participant_id):
        await send_error(websocket, "NOT_AUTHORIZED")
        db.close()
        await websocket.close(code=1008, reason="Participant was removed from this meeting")
        return

    if participant.left_at is not None:
        participant.left_at = None
        db.commit()

    if not await manager.connect(websocket, meeting_id, participant_id):
        db.close()
        return
    # Per-connection reaction timestamps for the in-memory rate limit. This
    # list lives only as long as the socket does.
    reaction_times: list[float] = []
    logger.info("[WS] join meeting=%s participant=%s", meeting_id, participant_id)
    await websocket.send_json({
        "type": "room_state",
        "meeting_id": meeting_id,
        "participants": active_room_participants(db, meeting_id),
    })
    logger.info("[WS] room_state meeting=%s participants=%d", meeting_id, len(manager.connected_participant_ids(meeting_id)))
    await manager.broadcast({
        "type": "participant_joined",
        "meeting_id": meeting_id,
        "participant_id": participant.id,
        "name": participant.display_name,
        "role": participant.role,
        "audio_enabled": participant.audio_enabled,
        "video_enabled": participant.video_enabled,
        "is_screen_sharing": participant.is_screen_sharing,
    }, meeting_id, exclude_participant=participant_id)

    try:
        while True:
            raw_message = await websocket.receive_text()
            try:
                data = json.loads(raw_message)
            except json.JSONDecodeError:
                await send_error(websocket, "INVALID_MESSAGE")
                continue

            event_type = validate_envelope(data)
            if event_type is None:
                await send_error(websocket, "INVALID_MESSAGE")
                continue
            logger.info("[WS] message received meeting=%s participant=%s type=%s", meeting_id, participant_id, event_type)

            if event_type == PING_EVENT:
                await websocket.send_json({"type": PONG_EVENT})
                continue
            if event_type == ECHO_EVENT:
                await websocket.send_json({"type": ECHO_EVENT, "data": data.get("data")})
                continue
            if event_type not in EVENT_TYPES and event_type not in TEST_EVENT_TYPES:
                await send_error(websocket, "UNKNOWN_MESSAGE_TYPE")
                continue

            if event_type in {OFFER_EVENT, ANSWER_EVENT, ICE_CANDIDATE_EVENT}:
                target_id = data.get("target_id")
                payload = data.get("payload")
                if not isinstance(target_id, str) or not target_id or not isinstance(payload, dict):
                    await send_error(websocket, "INVALID_SIGNALING_MESSAGE")
                    continue
                target = db.query(models.Participant).filter(
                    models.Participant.id == target_id,
                    models.Participant.meeting_id == meeting.id,
                    models.Participant.left_at.is_(None),
                ).first()
                if not target:
                    await send_error(websocket, "TARGET_NOT_CONNECTED")
                    continue
                delivered = await manager.send_to(meeting_id, target_id, {
                    "type": event_type,
                    "meeting_id": meeting_id,
                    "sender_id": participant_id,
                    "payload": payload,
                })
                if not delivered:
                    await send_error(websocket, "TARGET_NOT_CONNECTED")
                continue

            db.refresh(participant)
            if participant.left_at is not None:
                break
            if event_type in HOST_EVENT_TYPES and participant.role != "host":
                # Host requests are authorized against the role stored on the
                # connection's participant row — never against anything the
                # payload claims.
                await send_error(websocket, "FORBIDDEN")
                continue

            if event_type == AUDIO_STATE_EVENT or event_type == VIDEO_STATE_EVENT:
                # Media-state metadata. The sender's identity is the
                # connection's participant — a participant_id inside the
                # payload is never trusted. The value must be a real boolean
                # (bool("false") would silently mean True).
                state_key = "audio_enabled" if event_type == AUDIO_STATE_EVENT else "video_enabled"
                state_value = data.get(state_key)
                if not isinstance(state_value, bool):
                    await send_error(websocket, "INVALID_MEDIA_STATE")
                    continue
                setattr(participant, state_key, state_value)
                db.commit()
                await manager.broadcast({
                    "type": event_type,
                    "meeting_id": meeting_id,
                    "participant_id": participant_id,
                    state_key: state_value,
                }, meeting_id, exclude_participant=participant_id)
            elif event_type == "chat_message":
                # The server owns every identity field: sender, meeting and
                # timestamp come from the connection and the database, never
                # from the payload. The client only supplies the content.
                content = data.get("content")
                if not isinstance(content, str):
                    await send_error(websocket, "INVALID_CHAT_MESSAGE")
                    continue
                content = content.strip()
                if not content:
                    await send_error(websocket, "INVALID_CHAT_MESSAGE")
                    continue
                if len(content) > CHAT_MESSAGE_MAX_LENGTH:
                    await send_error(websocket, "CHAT_MESSAGE_TOO_LONG")
                    continue
                message = models.ChatMessage(meeting_id=meeting.id, participant_id=participant.id, content=content)
                db.add(message)
                db.commit()
                db.refresh(message)
                await manager.broadcast({
                    "type": "chat_message",
                    "message_id": message.id,
                    "meeting_id": meeting_id,
                    "sender_id": participant.id,
                    "sender_name": participant.display_name,
                    "content": message.content,
                    "timestamp": message.created_at.isoformat(),
                }, meeting_id)
            elif event_type == "reaction":
                # Ephemeral by design: validated, rate-limited, broadcast —
                # and never written to the database. Only the fixed set the
                # picker offers is accepted; anything else (arbitrary emoji,
                # text, numbers) is rejected.
                reaction = data.get("reaction")
                if reaction not in ALLOWED_REACTIONS:
                    await send_error(websocket, "INVALID_REACTION")
                    continue
                now = time.monotonic()
                reaction_times[:] = [sent_at for sent_at in reaction_times if now - sent_at < REACTION_RATE_WINDOW_SECONDS]
                if len(reaction_times) >= REACTION_RATE_LIMIT:
                    # Spam protection: drop the excess silently. The client
                    # loses nothing of value and gets no feedback loop.
                    continue
                reaction_times.append(now)
                await manager.broadcast({
                    "type": "reaction",
                    "meeting_id": meeting_id,
                    "participant_id": participant.id,
                    "participant_name": participant.display_name,
                    "reaction": reaction,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }, meeting_id)
            elif event_type == "screen_share_started":
                # One active sharer per meeting, enforced server-side so a
                # client-side race cannot produce two. The check-and-set below
                # has no awaits between them, so it is atomic per event loop.
                current_sharer = manager.screen_sharer(meeting_id)
                if current_sharer and current_sharer != participant_id:
                    await websocket.send_json({
                        "type": "error",
                        "code": "SCREEN_SHARE_ACTIVE",
                        "message": ERROR_MESSAGES["SCREEN_SHARE_ACTIVE"],
                    })
                    continue
                manager.set_screen_sharer(meeting_id, participant_id)
                participant.is_screen_sharing = True
                db.commit()
                await manager.broadcast({
                    "type": "screen_share_started",
                    "meeting_id": meeting_id,
                    "participant_id": participant.id,
                    "participant_name": participant.display_name,
                }, meeting_id, exclude_participant=participant_id)
            elif event_type == "screen_share_stopped":
                manager.clear_screen_sharer(meeting_id, participant_id)
                participant.is_screen_sharing = False
                db.commit()
                await manager.broadcast({
                    "type": "screen_share_stopped",
                    "meeting_id": meeting_id,
                    "participant_id": participant.id,
                    "participant_name": participant.display_name,
                }, meeting_id, exclude_participant=participant_id)
            elif event_type == "mute_all":
                # The server cannot touch another browser's microphone: it
                # broadcasts the moderation command and every receiving
                # client disables its own local track. The host is excluded
                # from the broadcast (and clients ignore their own command
                # as a second guard), so the host is never muted.
                await manager.broadcast({"type": "mute_all", "meeting_id": meeting_id, "initiated_by": participant.id}, meeting_id, exclude_participant=participant.id)
            elif event_type == "remove_participant":
                # Target validation: must exist, must be in THIS meeting (the
                # query is scoped to the connection's meeting, so a host in
                # meeting A can never remove someone from meeting B), must
                # not be the host themselves.
                target_id = data.get("target_participant_id")
                if not isinstance(target_id, str) or not target_id:
                    await send_error(websocket, "INVALID_TARGET")
                    continue
                if target_id == participant.id:
                    await send_error(websocket, "CANNOT_REMOVE_SELF")
                    continue
                target = db.query(models.Participant).filter(
                    models.Participant.id == target_id,
                    models.Participant.meeting_id == meeting.id,
                    models.Participant.left_at.is_(None),
                ).first()
                if not target:
                    await send_error(websocket, "INVALID_TARGET")
                    continue
                target.left_at = datetime.now(timezone.utc)
                db.commit()
                # Remember the revocation so the removed id cannot reconnect
                # (the connect handler revives left_at for refreshes).
                manager.mark_removed(meeting_id, target_id)
                await manager.broadcast({"type": "participant_removed", "meeting_id": meeting_id, "participant_id": target_id}, meeting_id)
            elif event_type == "meeting_ended":
                meeting.status = "ended"
                meeting.ended_at = datetime.now(timezone.utc)
                db.commit()
                await manager.broadcast({"type": "meeting_ended", "meeting_id": meeting_id, "ended_by": participant.id}, meeting_id)
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(meeting_id, participant_id)
        current = db.query(models.Participant).filter(models.Participant.id == participant_id).first()
        if current:
            if current.left_at is None:
                current.left_at = datetime.now(timezone.utc)
            # Screen share cannot survive a disconnect; clear the flag even
            # when left_at was already set (REST leave) so a rejoin's
            # room_state never reports a stale share.
            current.is_screen_sharing = False
            db.commit()
        if not manager.is_connected(meeting_id, participant_id):
            logger.info("[WS] participant_left meeting=%s participant=%s", meeting_id, participant_id)
            await manager.broadcast({"type": "participant_left", "meeting_id": meeting_id, "participant_id": participant_id}, meeting_id)
        db.close()
