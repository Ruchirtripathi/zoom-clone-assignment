PING_EVENT = "ping"
PONG_EVENT = "pong"
ECHO_EVENT = "echo"
OFFER_EVENT = "offer"
ANSWER_EVENT = "answer"
ICE_CANDIDATE_EVENT = "ice_candidate"
AUDIO_STATE_EVENT = "audio_state_changed"
VIDEO_STATE_EVENT = "video_state_changed"

EVENT_TYPES = {
    AUDIO_STATE_EVENT,
    VIDEO_STATE_EVENT,
    "chat_message",
    "reaction",
    "screen_share_started",
    "screen_share_stopped",
    "mute_all",
    "remove_participant",
    "meeting_ended",
    OFFER_EVENT,
    ANSWER_EVENT,
    ICE_CANDIDATE_EVENT,
}

# Requests only a meeting host may send. The role is always read from the
# database row bound to the connection — never from the payload.
HOST_EVENT_TYPES = {"mute_all", "remove_participant", "meeting_ended"}
TEST_EVENT_TYPES = {PING_EVENT, ECHO_EVENT}


def validate_envelope(message: object) -> str | None:
    if not isinstance(message, dict):
        return None
    event_type = message.get("type")
    return event_type.strip() if isinstance(event_type, str) and event_type.strip() else None