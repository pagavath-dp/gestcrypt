import { StudyRecorder } from './study.mjs?study-snapshot-v1';

export { StudyRecorder };

export const STUDY_STORAGE_KEY = 'gestcrypt.study.current.v1';
const MAX_SNAPSHOT_CHARS = 2_000_000;

export class StudyStore {
  constructor(storage, key = STUDY_STORAGE_KEY) {
    this.storage = storage;
    this.key = key;
    this.revision = null;
    this.lastRaw = null;
  }

  read() {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return null;
    if (raw.length > MAX_SNAPSHOT_CHARS) throw new Error('Study snapshot is too large; it was not changed.');
    let envelope;
    try { envelope = JSON.parse(raw); } catch { throw new Error('Study snapshot is corrupt; it was not changed.'); }
    if (!envelope || envelope.envelope_version !== 1 ||
        !Number.isSafeInteger(envelope.revision) || envelope.revision < 1) {
      throw new Error('Study snapshot version is unsupported; it was not changed.');
    }
    const study = StudyRecorder.fromSnapshot(envelope.state);
    this.revision = envelope.revision;
    this.lastRaw = raw;
    return study;
  }

  save(study) {
    const raw = this.storage.getItem(this.key);
    if (raw !== this.lastRaw) {
      throw new Error('Study storage changed in another tab. Export this tab and stop collection.');
    }
    if (raw !== null) {
      let current;
      try { current = JSON.parse(raw); } catch { throw new Error('Study storage is corrupt; it was not changed.'); }
      if (current.revision !== this.revision || current.state?.study_id !== study.studyId) {
        throw new Error('Study storage changed in another tab. Export this tab and stop collection.');
      }
    }
    const next = (this.revision ?? 0) + 1;
    const value = JSON.stringify({ envelope_version: 1, revision: next, state: study.snapshot() });
    if (value.length > MAX_SNAPSHOT_CHARS) throw new Error('Study snapshot is too large; export and end the study.');
    this.storage.setItem(this.key, value);
    this.revision = next;
    this.lastRaw = value;
  }

  clear(studyId) {
    const raw = this.storage.getItem(this.key);
    if (raw === null) throw new Error('No saved study exists to end.');
    let current;
    try { current = JSON.parse(raw); } catch { throw new Error('Corrupt study storage cannot be ended automatically.'); }
    if (raw !== this.lastRaw || current.revision !== this.revision || current.state?.study_id !== studyId) {
      throw new Error('Study storage changed in another tab; it was not removed.');
    }
    this.storage.removeItem(this.key);
    this.revision = null;
    this.lastRaw = null;
  }
}
