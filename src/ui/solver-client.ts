import type {
  EigenWorkerResponse,
  EigenWorkerSolveRequest,
  MembraneEigenSolution,
  SerializableMembraneSolverOptions,
  SolverProgress
} from "../solver";

export interface SolverClientCallbacks {
  readonly onProgress?: (progress: SolverProgress) => void;
}

export class SolverClient {
  private worker: Worker | null = null;
  private requestSequence = 0;
  private rejectActive: ((reason: Error) => void) | null = null;
  private destroyed = false;

  solve(
    mask: Uint8Array,
    width: number,
    height: number,
    options: SerializableMembraneSolverOptions,
    callbacks: SolverClientCallbacks = {}
  ): Promise<MembraneEigenSolution> {
    if (this.destroyed) return Promise.reject(new Error("The solver client has been destroyed."));
    this.cancel("A newer shape replaced this solve request.");
    const requestId = ++this.requestSequence;
    const worker = new Worker(new URL("../solver/eigen.worker.ts", import.meta.url), {
      type: "module",
      name: "membrane-eigenmodes"
    });
    this.worker = worker;

    return new Promise<MembraneEigenSolution>((resolve, reject) => {
      this.rejectActive = reject;
      const finish = (): void => {
        if (this.worker === worker) this.worker = null;
        if (this.rejectActive === reject) this.rejectActive = null;
        worker.terminate();
      };
      worker.addEventListener("message", (event: MessageEvent<EigenWorkerResponse>) => {
        const response = event.data;
        if (response.requestId !== requestId || this.worker !== worker) return;
        if (response.type === "progress") {
          callbacks.onProgress?.(response.progress);
        } else if (response.type === "result") {
          finish();
          resolve(response.solution);
        } else {
          finish();
          reject(new Error(response.message));
        }
      });
      worker.addEventListener("error", (event) => {
        if (this.worker !== worker) return;
        const message = event.message || "The numerical worker stopped unexpectedly.";
        finish();
        reject(new Error(message));
      });
      const transferableMask = mask.slice();
      const request: EigenWorkerSolveRequest = {
        type: "solve",
        requestId,
        width,
        height,
        mask: transferableMask,
        options
      };
      worker.postMessage(request, [transferableMask.buffer]);
    });
  }

  cancel(message = "The solve request was cancelled."): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    const reject = this.rejectActive;
    this.rejectActive = null;
    reject?.(new Error(message));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancel("The solver client was destroyed.");
  }
}
