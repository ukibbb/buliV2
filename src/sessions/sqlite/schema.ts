/** The first SQLite-only history format. Existing JSONL files are never imported. */
export const HISTORY_SCHEMA_VERSION = 2
export const HISTORY_APPLICATION_ID = 0x42554c49 // BULI

export const HISTORY_SCHEMA_V1 = `
CREATE TABLE sessions (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    active_branch_id TEXT NOT NULL,
    FOREIGN KEY (id, active_branch_id) REFERENCES branches(session_id, id)
        DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE branches (
    session_id TEXT NOT NULL,
    id TEXT NOT NULL CHECK (length(trim(id)) > 0),
    parent_branch_id TEXT,
    fork_message_id TEXT,
    inherited_checkpoint_id TEXT,
    PRIMARY KEY (session_id, id),
    CHECK ((id = 'main' AND parent_branch_id IS NULL AND fork_message_id IS NULL
                AND inherited_checkpoint_id IS NULL)
        OR (id <> 'main' AND parent_branch_id IS NOT NULL)),
    CHECK (parent_branch_id IS NULL OR parent_branch_id <> id),
    CHECK (fork_message_id IS NOT NULL OR inherited_checkpoint_id IS NULL),
    FOREIGN KEY (session_id) REFERENCES sessions(id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (session_id, parent_branch_id) REFERENCES branches(session_id, id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (session_id, fork_message_id) REFERENCES messages(session_id, id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (session_id, inherited_checkpoint_id) REFERENCES checkpoints(session_id, id)
        DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE messages (
    message_order INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    id TEXT NOT NULL CHECK (length(trim(id)) > 0),
    run_id TEXT NOT NULL CHECK (length(trim(run_id)) > 0),
    created_at INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'toolResult')),
    stop_reason TEXT,
    provider_visible INTEGER NOT NULL CHECK (provider_visible IN (0, 1)),
    assistant_message_id TEXT,
    tool_call_id TEXT,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    UNIQUE (session_id, id),
    CHECK ((role = 'assistant' AND stop_reason IS NOT NULL AND stop_reason <> 'pending')
        OR (role <> 'assistant' AND stop_reason IS NULL AND provider_visible = 0)),
    CHECK ((role = 'toolResult' AND assistant_message_id IS NOT NULL AND tool_call_id IS NOT NULL)
        OR (role <> 'toolResult' AND assistant_message_id IS NULL AND tool_call_id IS NULL)),
    FOREIGN KEY (session_id, branch_id) REFERENCES branches(session_id, id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (session_id, assistant_message_id, tool_call_id)
        REFERENCES tool_calls(session_id, assistant_message_id, tool_call_id)
        DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE tool_calls (
    session_id TEXT NOT NULL,
    assistant_message_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL CHECK (length(trim(tool_call_id)) > 0),
    tool_call_index INTEGER NOT NULL CHECK (tool_call_index >= 0),
    tool_name TEXT NOT NULL CHECK (length(trim(tool_name)) > 0),
    PRIMARY KEY (session_id, assistant_message_id, tool_call_id),
    UNIQUE (session_id, assistant_message_id, tool_call_index),
    FOREIGN KEY (session_id, assistant_message_id) REFERENCES messages(session_id, id)
        DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE checkpoints (
    checkpoint_order INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    id TEXT NOT NULL CHECK (length(trim(id)) > 0),
    through_message_id TEXT NOT NULL,
    compacted_message_count INTEGER NOT NULL CHECK (compacted_message_count > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    UNIQUE (session_id, id),
    FOREIGN KEY (session_id, branch_id) REFERENCES branches(session_id, id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (session_id, through_message_id) REFERENCES messages(session_id, id)
        DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX messages_branch_order ON messages(session_id, branch_id, message_order);
CREATE INDEX messages_branch_role_order ON messages(session_id, branch_id, role, message_order);
CREATE INDEX messages_tool_result ON messages(session_id, assistant_message_id, tool_call_id, message_order);
CREATE INDEX checkpoints_branch_order ON checkpoints(session_id, branch_id, checkpoint_order);
CREATE INDEX checkpoints_anchor ON checkpoints(session_id, through_message_id);
CREATE INDEX branches_parent ON branches(session_id, parent_branch_id);
CREATE INDEX branches_anchor ON branches(session_id, fork_message_id);
CREATE INDEX branches_checkpoint ON branches(session_id, inherited_checkpoint_id);
CREATE INDEX sessions_active_branch ON sessions(id, active_branch_id);
`

export const DELEGATED_TASK_SCHEMA = `
CREATE TABLE delegated_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    parent_session_id TEXT NOT NULL,
    assistant_message_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    child_session_id TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 2),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    UNIQUE (parent_session_id, assistant_message_id, tool_call_id, position),
    CHECK (parent_session_id <> child_session_id),
    FOREIGN KEY (parent_session_id, assistant_message_id, tool_call_id)
        REFERENCES tool_calls(session_id, assistant_message_id, tool_call_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (child_session_id) REFERENCES sessions(id)
        DEFERRABLE INITIALLY DEFERRED
) STRICT;
`

export const HISTORY_SCHEMA = HISTORY_SCHEMA_V1 + DELEGATED_TASK_SCHEMA
