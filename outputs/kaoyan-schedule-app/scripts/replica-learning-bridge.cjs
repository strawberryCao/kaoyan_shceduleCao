const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson, sha256 } = require('./sync-core.cjs');

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function noteMap(snapshot) {
  const result = new Map();
  for (const [date, day] of Object.entries(snapshot?.days || {})) {
    for (const note of Array.isArray(day?.autoNotes) ? day.autoNotes : []) {
      if (note?.noteUid) result.set(String(note.noteUid), { ...structuredClone(note), capturedDate: note.capturedDate || date });
    }
  }
  return result;
}

function cardMap(snapshot) {
  return new Map((Array.isArray(snapshot?.cards) ? snapshot.cards : [])
    .filter((card) => card?.id)
    .map((card) => [String(card.id), structuredClone(card)]));
}

function withoutLocalPaths(value) {
  if (Array.isArray(value)) return value.map(withoutLocalPaths);
  if (!isObject(value)) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/path$/i.test(key) && typeof child === 'string' && (path.isAbsolute(child) || path.win32.isAbsolute(child))) continue;
    result[key] = withoutLocalPaths(child);
  }
  return result;
}

function attachmentHash(attachment) {
  const checksum = /^sha256:([a-f0-9]{64})$/i.exec(String(attachment?.checksum || ''));
  if (checksum) return checksum[1].toLowerCase();
  const filePath = String(attachment?.filePath || '');
  if (!filePath || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) return '';
  return sha256(fs.readFileSync(filePath));
}

function portableNote(note) {
  const portable = withoutLocalPaths(note || {});
  const attachments = Array.isArray(note?.attachments) ? note.attachments : [];
  portable.attachments = attachments.map((attachment) => {
    const assetHash = attachmentHash(attachment);
    return {
      ...withoutLocalPaths(attachment),
      ...(assetHash ? { assetHash } : {}),
    };
  });
  return portable;
}

function changedFields(previous, next) {
  const fields = {};
  const unset = [];
  const sets = {};
  const setFields = new Set(['tags', 'facets', 'cardIds', 'userEditedFields', 'completedTaskIds']);
  const keys = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
  for (const key of keys) {
    if (!Object.hasOwn(next || {}, key)) {
      unset.push(key);
    } else if (setFields.has(key) && Array.isArray(previous?.[key]) && Array.isArray(next[key])) {
      const before = new Set(previous[key].map(String));
      const after = new Set(next[key].map(String));
      const add = [...after].filter((value) => !before.has(value));
      const remove = [...before].filter((value) => !after.has(value));
      if (add.length || remove.length) sets[key] = { add, remove };
    } else if (canonicalJson(previous?.[key]) !== canonicalJson(next[key])) {
      fields[key] = structuredClone(next[key]);
    }
  }
  return { fields, unset, sets };
}

function hasManualContent(value) {
  const record = isObject(value) ? value : {};
  return (Array.isArray(record.completedTaskIds) && record.completedTaskIds.length > 0)
    || ['note', 'debt', 'mistakes'].some((key) => String(record[key] || '').trim());
}

function noteAssets(note) {
  return (Array.isArray(note?.attachments) ? note.attachments : [])
    .filter((attachment) => {
      const filePath = String(attachment?.filePath || '');
      return filePath && path.isAbsolute(filePath) && fs.existsSync(filePath);
    })
    .map((attachment) => ({ filePath: attachment.filePath, mimeType: attachment.mimeType || attachment.mime || 'application/octet-stream' }));
}

function createReplicaLearningBridge(options) {
  const replica = options.replica;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  if (!replica) throw new Error('Replica learning bridge requires a Windows replica store.');

  function queuePatch(entityType, entityId, previous, next, source, assets = []) {
    const patch = changedFields(previous || {}, next || {});
    if (Object.keys(patch.fields).length === 0 && patch.unset.length === 0 && Object.keys(patch.sets).length === 0) return null;
    return replica.queueMutation({
      operationId: crypto.randomUUID(),
      entityType,
      entityId,
      mutation: { kind: 'patch', source, ...patch },
      assets,
    });
  }

  function captureCommit(previousSnapshot, nextSnapshot, mutationOptions = {}) {
    if (mutationOptions.skipReplicaCapture === true) return { queued: 0 };
    const source = mutationOptions.syncSource === 'ai'
      || (mutationOptions.trackUserEdits === false && mutationOptions.syncSource !== 'system')
      ? 'ai'
      : mutationOptions.syncSource === 'system' ? 'system' : 'human';
    let queued = 0;
    try {
      const previousNotes = noteMap(previousSnapshot);
      const nextNotes = noteMap(nextSnapshot);
      for (const noteUid of new Set([...previousNotes.keys(), ...nextNotes.keys()])) {
        const before = previousNotes.get(noteUid);
        const after = nextNotes.get(noteUid);
        if (before && !after) {
          replica.queueMutation({ entityType: 'learning-note', entityId: noteUid, mutation: { kind: 'delete', source: 'human' } });
          queued += 1;
          continue;
        }
        if (!after) continue;
        const existing = replica.getEntity('learning-note', noteUid);
        if (!before && existing?.deleted) {
          replica.queueMutation({ entityType: 'learning-note', entityId: noteUid, mutation: { kind: 'restore', source: 'human' } });
          queued += 1;
        }
        if (queuePatch('learning-note', noteUid, before ? portableNote(before) : {}, portableNote(after), source, noteAssets(after))) queued += 1;
      }

      const previousCards = cardMap(previousSnapshot);
      const nextCards = cardMap(nextSnapshot);
      for (const cardId of new Set([...previousCards.keys(), ...nextCards.keys()])) {
        const before = previousCards.get(cardId);
        const after = nextCards.get(cardId);
        if (before && !after) {
          replica.queueMutation({ entityType: 'learning-card', entityId: cardId, mutation: { kind: 'delete', source: 'human' } });
          queued += 1;
        } else if (after) {
          const existing = replica.getEntity('learning-card', cardId);
          if (!before && existing?.deleted) {
            replica.queueMutation({ entityType: 'learning-card', entityId: cardId, mutation: { kind: 'restore', source: 'human' } });
            queued += 1;
          }
          if (queuePatch('learning-card', cardId, before || {}, withoutLocalPaths(after), source)) queued += 1;
        }
      }

      const dates = new Set([...Object.keys(previousSnapshot?.days || {}), ...Object.keys(nextSnapshot?.days || {})]);
      for (const date of dates) {
        const before = previousSnapshot?.days?.[date]?.manual || {};
        const after = nextSnapshot?.days?.[date]?.manual || {};
        if (!hasManualContent(before) && !hasManualContent(after)) continue;
        if (queuePatch('learning-day', date, withoutLocalPaths(before), withoutLocalPaths(after), source)) queued += 1;
      }
      return { queued };
    } catch (error) {
      onError(error);
      throw error;
    }
  }

  return {
    captureCommit,
    noteStatus(noteUid) {
      return replica.entityStatus('learning-note', noteUid);
    },
    status: () => replica.status(),
  };
}

module.exports = {
  attachmentHash,
  changedFields,
  createReplicaLearningBridge,
  portableNote,
};
