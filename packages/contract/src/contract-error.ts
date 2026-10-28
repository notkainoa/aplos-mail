import type { ErrorBody, ErrorType } from './errors';

/*
 * The error classes, in a module with no zod import, so the neutral engine can throw them without bundling the schemas
 * (the engine validates nothing itself: transports validate at the host boundary, ARCH 9.3).
 */

/** The one error class every host throws and every client receives for a failed call, so `type` survives transports. */
export class ContractError extends Error {
  readonly type: ErrorType | (string & {});
  constructor(readonly body: ErrorBody) {
    super(body.message);
    this.name = 'ContractError';
    this.type = body.type;
  }
}

/** What an F5 stub throws until its lane fills the handler. */
export class NotImplementedError extends ContractError {
  constructor(readonly method: string) {
    super({ type: 'notImplemented', message: 'This part of Aplos is not built yet.' });
    this.name = 'NotImplementedError';
  }
}
