/// <reference lib="webworker" />

import { EigenmodeSolverError, solveMembraneModes } from "./solver";
import type {
  EigenWorkerErrorResponse,
  EigenWorkerProgressResponse,
  EigenWorkerResultResponse,
  EigenWorkerSolveRequest,
  MembraneSolverOptions
} from "./types";

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.addEventListener(
  "message",
  (event: MessageEvent<EigenWorkerSolveRequest>): void => {
    const request = event.data;
    if (request.type !== "solve") return;

    try {
      const options: MembraneSolverOptions = {
        ...(request.options ?? {}),
        onProgress: (progress) => {
          const response: EigenWorkerProgressResponse = {
            type: "progress",
            requestId: request.requestId,
            progress
          };
          workerScope.postMessage(response);
        }
      };
      const solution = solveMembraneModes(
        request.mask,
        request.width,
        request.height,
        options
      );
      const response: EigenWorkerResultResponse = {
        type: "result",
        requestId: request.requestId,
        solution
      };
      const transfers: Transferable[] = [solution.mask.buffer];
      for (const mode of solution.modes) transfers.push(mode.values.buffer);
      workerScope.postMessage(response, transfers);
    } catch (error: unknown) {
      const response: EigenWorkerErrorResponse = {
        type: "error",
        requestId: request.requestId,
        code: error instanceof EigenmodeSolverError ? error.code : "UNKNOWN",
        message: error instanceof Error ? error.message : String(error)
      };
      workerScope.postMessage(response);
    }
  }
);

