const { normalizeSnapshot } = require('./learning-data-store.cjs');

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function defaultDay() {
  return { manual: { completedTaskIds: [], note: '', debt: '', mistakes: '' }, autoNotes: [] };
}

function attachLocalAssets(document, replica) {
  const next = structuredClone(document || {});
  if (!Array.isArray(next.attachments)) return next;
  next.attachments = next.attachments.map((attachment) => {
    const asset = attachment?.assetHash ? replica.getAsset(attachment.assetHash) : null;
    return asset ? { ...attachment, filePath: asset.filePath, size: asset.size } : attachment;
  });
  const primary = next.attachments[0];
  if (primary?.filePath) {
    next.filePath = primary.filePath;
    next.fileName = primary.name || next.fileName;
  }
  return next;
}

function removeLiveNote(snapshot, noteUid) {
  for (const [date, day] of Object.entries(snapshot.days || {})) {
    const notes = Array.isArray(day?.autoNotes) ? day.autoNotes : [];
    snapshot.days[date] = { ...day, autoNotes: notes.filter((note) => note?.noteUid !== noteUid) };
  }
}

function applyEntity(snapshot, entity, replica) {
  if (entity.entityType === 'learning-note') {
    removeLiveNote(snapshot, entity.entityId);
    delete snapshot.deletedNotes[entity.entityId];
    const note = attachLocalAssets({ ...entity.document, noteUid: entity.entityId }, replica);
    if (entity.deleted) {
      snapshot.deletedNotes[entity.entityId] = {
        deletedAt: entity.updatedAt,
        note,
        cards: snapshot.cards.filter((card) => card.noteUid === entity.entityId),
      };
      snapshot.cards = snapshot.cards.filter((card) => card.noteUid !== entity.entityId);
      return;
    }
    const capturedDate = isDate(note.capturedDate) ? note.capturedDate : new Date(entity.updatedAt).toISOString().slice(0, 10);
    snapshot.days[capturedDate] ||= defaultDay();
    snapshot.days[capturedDate].autoNotes ||= [];
    snapshot.days[capturedDate].autoNotes.push({ ...note, capturedDate });
    return;
  }
  if (entity.entityType === 'learning-card') {
    snapshot.cards = snapshot.cards.filter((card) => card?.id !== entity.entityId);
    if (!entity.deleted) snapshot.cards.push({ ...structuredClone(entity.document), id: entity.entityId });
    return;
  }
  if (entity.entityType === 'learning-day' && isDate(entity.entityId) && !entity.deleted) {
    snapshot.days[entity.entityId] ||= defaultDay();
    snapshot.days[entity.entityId].manual = structuredClone(entity.document);
  }
}

function createReplicaLearningMaterializer(options) {
  const replica = options.replica;
  const learningData = options.learningData;
  if (!replica || !learningData) throw new Error('Replica materializer requires replica and learning data stores.');

  function reconcile(maxAttempts = 3, force = false) {
    const remoteCursor = replica.getRemoteCursor();
    if (!force && replica.getMaterializedCursor('learning') === remoteCursor) {
      return { changed: false, entities: replica.listEntities().length, revision: learningData.getSnapshot().revision, cursor: remoteCursor };
    }
    const entities = replica.listEntities();
    if (entities.length === 0) {
      replica.markMaterializedCursor(remoteCursor, 'learning');
      return { changed: false, entities: 0, revision: learningData.getSnapshot().revision, cursor: remoteCursor };
    }
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const current = learningData.getSnapshot();
      const next = structuredClone(current);
      for (const entity of entities) applyEntity(next, entity, replica);
      const normalizedNext = normalizeSnapshot(next);
      const before = JSON.stringify({ days: current.days, cards: current.cards, deletedNotes: current.deletedNotes });
      const after = JSON.stringify({ days: normalizedNext.days, cards: normalizedNext.cards, deletedNotes: normalizedNext.deletedNotes });
      if (before === after) {
        replica.markMaterializedCursor(remoteCursor, 'learning');
        return { changed: false, entities: entities.length, revision: current.revision, cursor: remoteCursor };
      }
      try {
        const saved = learningData.restoreSnapshot(normalizedNext, { expectedRevision: current.revision, skipReplicaCapture: true, syncSource: 'system' });
        replica.markMaterializedCursor(remoteCursor, 'learning');
        return { changed: true, entities: entities.length, revision: saved.revision, cursor: remoteCursor };
      } catch (error) {
        if (error?.code !== 'REVISION_CONFLICT' && error?.name !== 'LearningDataConflictError') throw error;
      }
    }
    const error = new Error('Learning data changed repeatedly while applying Mac events.');
    error.code = 'REPLICA_MATERIALIZE_BUSY';
    throw error;
  }

  return { reconcile };
}

module.exports = { applyEntity, attachLocalAssets, createReplicaLearningMaterializer };
