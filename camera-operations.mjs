// Shared by study capture and the Vault gesture service. A busy camera rejects
// a competing operation instead of queuing an observation from the wrong flow.
export class CameraOperationCoordinator {
  constructor() { this.active = null; }

  acquire(owner) {
    if (this.active) throw new Error('A camera operation is already in progress. Wait for it to finish.');
    const token = Symbol(owner);
    this.active = token;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.active === token) this.active = null;
    };
  }

  async run(owner, operation) {
    const release = this.acquire(owner);
    try { return await operation(); }
    finally { release(); }
  }
}

export const sharedCameraOperations = new CameraOperationCoordinator();
