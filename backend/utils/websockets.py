import logging
from fastapi import WebSocket
from typing import Dict, Optional

logger = logging.getLogger("meetspace.websocket")

class ConnectionManager:
    def __init__(self):
        # meeting_id -> { participant_id -> WebSocket }
        self.active_connections: Dict[str, Dict[str, WebSocket]] = {}
        # Ephemeral single-screen-sharer rule: meeting_id -> participant_id.
        # In-memory only — screen sharing is transient room state and is never
        # persisted. Cleared when the sharer stops or disconnects.
        self.screen_sharers: Dict[str, str] = {}
        # Membership revocations: meeting_id -> { participant_id }. A removed
        # participant's row keeps left_at set, but the connect handler revives
        # left_at participants (a refresh mid-meeting depends on that), so
        # removals are remembered here to reject the stale id. Fresh joins
        # always create a NEW participant row, so a mark never blocks the
        # person — only the removed session's id. In-memory like the sharer
        # map: a server restart clears it, which is acceptable because the
        # removed row still has left_at set.
        self.removed_participants: Dict[str, set] = {}

    def mark_removed(self, meeting_id: str, participant_id: str) -> None:
        self.removed_participants.setdefault(meeting_id, set()).add(participant_id)
        logger.info("[WS] participant removed meeting=%s participant=%s", meeting_id, participant_id)

    def is_removed(self, meeting_id: str, participant_id: str) -> bool:
        return participant_id in self.removed_participants.get(meeting_id, set())

    async def connect(self, websocket: WebSocket, meeting_id: str, participant_id: str) -> bool:
        if meeting_id not in self.active_connections:
            self.active_connections[meeting_id] = {}
        if participant_id in self.active_connections[meeting_id]:
            await websocket.send_json({
                "type": "error",
                "code": "DUPLICATE_CONNECTION",
                "message": "This participant already has an active connection.",
            })
            await websocket.close(code=4008, reason="Duplicate participant connection")
            return False
        self.active_connections[meeting_id][participant_id] = websocket
        logger.info("[WS] participant connected meeting=%s participant=%s", meeting_id, participant_id)
        return True

    def screen_sharer(self, meeting_id: str) -> Optional[str]:
        return self.screen_sharers.get(meeting_id)

    def set_screen_sharer(self, meeting_id: str, participant_id: str) -> None:
        self.screen_sharers[meeting_id] = participant_id
        logger.info("[WS] screen share started meeting=%s participant=%s", meeting_id, participant_id)

    def clear_screen_sharer(self, meeting_id: str, participant_id: str) -> None:
        # Only the current sharer (or their disconnect) may release the slot.
        if self.screen_sharers.get(meeting_id) == participant_id:
            del self.screen_sharers[meeting_id]
            logger.info("[WS] screen share stopped meeting=%s participant=%s", meeting_id, participant_id)

    def is_connected(self, meeting_id: str, participant_id: str) -> bool:
        return participant_id in self.active_connections.get(meeting_id, {})

    async def send_to(self, meeting_id: str, participant_id: str, message: dict) -> bool:
        connection = self.active_connections.get(meeting_id, {}).get(participant_id)
        if not connection:
            return False
        try:
            await connection.send_json(message)
            return True
        except Exception:
            self.disconnect(meeting_id, participant_id)
            return False

    def connected_participant_ids(self, meeting_id: str) -> list[str]:
        return list(self.active_connections.get(meeting_id, {}).keys())

    def disconnect(self, meeting_id: str, participant_id: str):
        if meeting_id in self.active_connections:
            if participant_id in self.active_connections[meeting_id]:
                del self.active_connections[meeting_id][participant_id]
                logger.info("[WS] participant disconnected meeting=%s participant=%s", meeting_id, participant_id)
            if not self.active_connections[meeting_id]:
                del self.active_connections[meeting_id]
        # A disconnected sharer frees the slot for everyone else.
        self.clear_screen_sharer(meeting_id, participant_id)

    async def broadcast(self, message: dict, meeting_id: str, exclude_participant: Optional[str] = None):
        if meeting_id in self.active_connections:
            # We copy items to list to avoid runtime error if dictionary changes size during iteration
            connections = list(self.active_connections[meeting_id].items())
            for p_id, connection in connections:
                if p_id != exclude_participant:
                    try:
                        await connection.send_json(message)
                    except Exception:
                        self.disconnect(meeting_id, p_id)

manager = ConnectionManager()
