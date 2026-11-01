-- 015-life-gate：消息闸门（P2）
-- 消息到了服务器但她在忙/在睡时，先攒着，到点再回。
ALTER TABLE messages ADD COLUMN reply_state TEXT;   -- pending / answered
ALTER TABLE messages ADD COLUMN hold_until_ms INTEGER;
CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(reply_state, hold_until_ms);
