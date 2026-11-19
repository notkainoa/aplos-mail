/**
 * The data layer on the stand-in engine (F6) in-process: what a development build and the data tests boot. Never part
 * of a release (plan 30 4.1 release rule).
 */
import type { EngineConnection } from '@aplos/contract/client';
import { inProcessTransport } from './client';
import { connectDataLayer, type DataConnection } from './connect';
import type { DataLayerOptions } from './layer';
import { withNativeStubs } from './native-stub';
import { connectStandIn, type StandInOptions } from './standin';

/** The connected layer plus the engine, for a second connection (`fixtureControl(engine)` in tests). */
export interface StandInDataLayer extends DataConnection {
  readonly engine: EngineConnection;
}

export function connectStandInDataLayer(
  options: StandInOptions & Omit<DataLayerOptions, 'session'> = {},
): StandInDataLayer {
  const standIn = connectStandIn(options);
  const connection = connectDataLayer({
    ...options,
    session: withNativeStubs(inProcessTransport(standIn.engine)),
  });
  return {
    ...connection,
    engine: standIn.engine,
    close() {
      connection.close();
      standIn.close();
    },
  };
}
