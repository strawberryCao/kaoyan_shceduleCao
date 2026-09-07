const { normalizeSnapshot } = require('./learning-data-store.cjs');
const { applyEntity } = require('./replica-learning-materializer.cjs');

function createAuthorityLearningMaterializer(options) {
  const authority = options.authority;
  const learningData = options.learningData;
  if (!authority || !learningData) throw new Error('Authority materializer requires sync and learning stores.');

  function reconcile(maxAttempts = 3) {
    const entities = authority.listEntities().filter((entity) => entity.entityType.startsWith('learning-'));
    if (entities.length === 0) return { changed: false, entities: 0, revision: learningData.getSnapshot().revision };
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const current = learningData.getSnapshot();
      const next = structuredClone(current);
      for (const entity of entities) applyEntity(next, entity, authority);
      const normalized = normalizeSnapshot(next);
      const before = JSON.stringify({ days: current.days, cards: current.cards, deletedNotes: current.deletedNotes });
      const after = JSON.stringify({ days: normalized.days, cards: normalized.cards, deletedNotes: normalized.deletedNotes });
      if (before === after) return { changed: false, entities: entities.length, revision: current.revision };
      try {
        const saved = learningData.restoreSnapshot(normalized, {
          expectedRevision: current.revision,
          skipReplicaCapture: true,
          syncSource: 'system',
        });
        return { changed: true, entities: entities.length, revision: saved.revision };
      } catch (error) {
        if (error?.code !== 'REVISION_CONFLICT' && error?.name !== 'LearningDataConflictError') throw error;
      }
    }
    const error = new Error('Mac learning data remained busy while applying synchronized entities.');
    error.code = 'AUTHORITY_MATERIALIZE_BUSY';
    throw error;
  }

  return { reconcile };
}

module.exports = { createAuthorityLearningMaterializer };
