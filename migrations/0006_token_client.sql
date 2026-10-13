-- The AI app (MCP client) last seen using each access key, from its MCP initialize message,
-- e.g. "claude-code". Lets Connect your AI show Claude Code as connected.
ALTER TABLE tokens ADD COLUMN client_name TEXT;
