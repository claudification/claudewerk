import type { Database } from 'bun:sqlite'
import type { TaskRecord, TaskStore } from '../types'

function rowToTask(row: Record<string, string | number | null>): TaskRecord {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    kind: row.kind as TaskRecord['kind'],
    status: row.status as string,
    name: (row.name as string) ?? undefined,
    data: row.data ? JSON.parse(row.data as string) : undefined,
    createdAt: row.created_at as number,
    updatedAt: (row.updated_at as number) ?? undefined,
  }
}

export function createSqliteTaskStore(db: Database): TaskStore {
  const stmtUpsert = db.prepare(`
    INSERT INTO tasks (id, conversation_id, kind, status, name, data, created_at, updated_at)
    VALUES ($id, $conversationId, $kind, $status, $name, $data, $createdAt, $updatedAt)
    ON CONFLICT(conversation_id, id) DO UPDATE SET
      kind = $kind, status = $status, name = $name, data = $data, updated_at = $updatedAt
  `)
  const stmtForConversation = db.prepare('SELECT * FROM tasks WHERE conversation_id = $conversationId')
  const stmtForSessionKind = db.prepare('SELECT * FROM tasks WHERE conversation_id = $conversationId AND kind = $kind')
  const stmtDelete = db.prepare('DELETE FROM tasks WHERE conversation_id = $conversationId AND id = $id')
  const stmtDeleteAll = db.prepare('DELETE FROM tasks WHERE conversation_id = $conversationId')

  return {
    upsert(conversationId, task) {
      stmtUpsert.run({
        id: task.id,
        conversationId: conversationId,
        kind: task.kind,
        status: task.status,
        name: task.name ?? null,
        data: task.data ? JSON.stringify(task.data) : null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt ?? null,
      })
    },

    getForConversation(conversationId, kind?) {
      if (kind) {
        const rows = stmtForSessionKind.all({ conversationId, kind }) as Record<string, string | number | null>[]
        return rows.map(rowToTask)
      }
      const rows = stmtForConversation.all({ conversationId }) as Record<string, string | number | null>[]
      return rows.map(rowToTask)
    },

    delete(conversationId, taskId) {
      const result = stmtDelete.run({ conversationId, id: taskId })
      return result.changes > 0
    },

    deleteForConversation(conversationId) {
      const result = stmtDeleteAll.run({ conversationId })
      return result.changes
    },
  }
}
