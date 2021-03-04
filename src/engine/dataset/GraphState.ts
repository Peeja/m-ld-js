import {
  MeldReadState, Resource,
  ReadResult, readResult
} from '../../api';
import { Subject } from '../../jrql-support';
import { JrqlGraph } from './JrqlGraph';
import { map } from 'rxjs/operators';
import { Read } from '../..';

/**
 * Utility class to directly coerce a JrqlGraph to be a MeldReadState, with no
 * context.
 */
export class GraphState implements MeldReadState {
  constructor(
    readonly graph: JrqlGraph) {
  }

  read<S>(request: Read) {
    return readResult(this.graph.read(request)
      .pipe(map(subject => <Resource<S>>subject)));
  }

  get<S = Subject>(id: string) {
    return <Promise<Resource<S> | undefined>>this.graph.describe1(id).toPromise();
  }
}
