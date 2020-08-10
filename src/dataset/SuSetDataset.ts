import { JsonDelta, Snapshot, UUID, MeldUpdate, DeltaMessage, Triple, MeldConstraint, MeldDelta } from '../m-ld';
import { Quad } from 'rdf-js';
import { TreeClock } from '../clocks';
import { Hash } from '../hash';
import { Subject } from './jrql-support';
import { Dataset, PatchQuads } from '.';
import { flatten as flatJsonLd } from 'jsonld';
import { Iri } from 'jsonld/jsonld-spec';
import { JrqlGraph } from './JrqlGraph';
import { MeldJson, unreify, hashTriple, toDomainQuad, TripleTids } from '../m-ld/MeldJson';
import { Observable, from, Subject as Source, asapScheduler, Observer } from 'rxjs';
import { toArray, bufferCount, flatMap, reduce, observeOn, map } from 'rxjs/operators';
import { flatten, Future, tapComplete, getIdLogger, check, rdfToJson } from '../util';
import { generate as uuid } from 'short-uuid';
import { Logger } from 'loglevel';
import { MeldError } from '../m-ld/MeldError';
import { LocalLock } from '../local';
import { SUSET_CONTEXT, qsName, toPrefixedId } from './SuSetGraph';
import { SuSetJournal, SuSetJournalEntry } from './SuSetJournal';
import { MeldConfig } from '..';
import { CheckList } from '../constraints/CheckList';

interface HashTid extends Subject {
  '@id': Iri; // hash:<hashed triple id>
  tid: UUID; // Transaction ID
}

interface AllTids extends Subject {
  '@id': 'qs:all'; // Singleton object
  tid: UUID[];
}

type DatasetSnapshot = Omit<Snapshot, 'updates'>;

class TripleTidQuads {
  constructor(
    readonly triple: Triple,
    readonly tids: Quad[]) {
  }

  asTripleTids(): TripleTids {
    return new TripleTids(this.triple, this.tids.map(tidQuad => tidQuad.object.value));
  }
}

interface ConstraintTxn {
  delta: MeldDelta;
  update: MeldUpdate;
  patch: PatchQuads;
  allTidsPatch: PatchQuads;
  tidPatch: PatchQuads;
}

/**
 * Writeable Graph, similar to a Dataset, but with a slightly different transaction API.
 * Journals every transaction and creates m-ld compliant deltas.
 */
export class SuSetDataset extends JrqlGraph {
  private static checkNotClosed =
    check((d: SuSetDataset) => !d.dataset.closed, () => new MeldError('Clone has closed'));

  private readonly meldJson: MeldJson;
  private readonly tidsGraph: JrqlGraph;
  private readonly journal: SuSetJournal;
  private readonly updateSource: Source<MeldUpdate> = new Source;
  readonly updates: Observable<MeldUpdate>
  private readonly datasetLock: LocalLock;
  private readonly log: Logger;
  private readonly constraint: MeldConstraint;

  constructor(private readonly dataset: Dataset, config: MeldConfig) {
    super(dataset.graph());
    this.meldJson = new MeldJson(config['@domain']);
    // Named graph for control quads e.g. Journal (note graph name is legacy)
    this.journal = new SuSetJournal(new JrqlGraph(
      dataset.graph(qsName('control')), SUSET_CONTEXT));
    this.tidsGraph = new JrqlGraph(
      dataset.graph(qsName('tids')), SUSET_CONTEXT);
    // Update notifications are strictly ordered but don't hold up transactions
    this.updates = this.updateSource.pipe(observeOn(asapScheduler));
    this.datasetLock = new LocalLock(config['@id'], dataset.location);
    this.log = getIdLogger(this.constructor, config['@id'], config.logLevel);
    this.constraint = config.constraint ?? new CheckList([]);
  }

  @SuSetDataset.checkNotClosed.async
  async initialise() {
    // Check for exclusive access to the dataset location
    try {
      await this.datasetLock.acquire();
    } catch (err) {
      throw new MeldError('Clone data is locked', err);
    }
    // Create the Journal if not exists
    return this.dataset.transact({
      id: 'suset-reset',
      prepare: async () => {
        const journalPatch = await this.journal.initialise();
        return journalPatch != null ? { patch: journalPatch } : {};
      }
    });
  }

  @SuSetDataset.checkNotClosed.async
  async close(err?: any) {
    if (err) {
      this.log.warn('Shutting down due to', err);
      this.updateSource.error(err);
    } else {
      this.log.info('Shutting down normally');
      this.updateSource.complete();
    }
    this.datasetLock.release();
    return this.dataset.close();
  }

  @SuSetDataset.checkNotClosed.async
  async loadClock(): Promise<TreeClock | null> {
    return (await this.journal.state()).maybeTime;
  }

  @SuSetDataset.checkNotClosed.async
  async saveClock(localTime: TreeClock, newClone?: boolean): Promise<void> {
    return this.dataset.transact({
      id: 'suset-save-clock',
      prepare: async () =>
        ({ patch: await (await this.journal.state()).setLocalTime(localTime, newClone) })
    });
  }

  /**
   * @return the last hash seen in the journal.
   */
  @SuSetDataset.checkNotClosed.async
  async lastHash(): Promise<Hash> {
    const journal = await this.journal.state();
    const tail = await journal.tail();
    return tail.hash;
  }

  private emitJournalFrom(entry: SuSetJournalEntry | undefined,
    subs: Observer<DeltaMessage>, filter: (entry: SuSetJournalEntry) => boolean) {
    if (subs.closed == null || !subs.closed) {
      if (entry != null) {
        if (this.dataset.closed) {
          subs.error(new MeldError('Clone has closed'));
        } else {
          if (filter(entry))
            subs.next(new DeltaMessage(entry.time, entry.delta));

          entry.next().then(next => this.emitJournalFrom(next, subs, filter),
            err => subs.error(err));
        }
      } else {
        subs.complete();
      }
    }
  }

  /**
   * To ensure we have processed any prior updates we always process a revup
   * request in a transaction lock.
   */
  @SuSetDataset.checkNotClosed.async
  async operationsSince(time: TreeClock): Promise<Observable<DeltaMessage> | undefined> {
    return this.dataset.transact<Observable<DeltaMessage> | undefined>({
      id: 'suset-ops-since',
      prepare: async () => {
        const journal = await this.journal.state();
        // How many ticks of mine has the requester seen?
        const ticks = time.getTicks(journal.time);
        const found = ticks != null ? await journal.findEntry(ticks) : '';
        return {
          value: found ? new Observable(subs =>
            // Don't emit an entry if it's all less than the requested time
            this.emitJournalFrom(found, subs, entry => time.anyLt(entry.time, 'includeIds'))) : undefined
        };
      }
    });
  }

  @SuSetDataset.checkNotClosed.async
  async transact(prepare: () => Promise<[TreeClock, PatchQuads]>): Promise<DeltaMessage> {
    return this.dataset.transact<DeltaMessage>({
      id: uuid(), // New transaction ID
      prepare: async txc => {
        const [time, patch] = await prepare();
        const update = await this.asUpdate(time, patch);

        txc.sw.next('check-constraints');
        await this.constraint.check(update, query => this.read(query));

        txc.sw.next('find-tids');
        const deletedTriplesTids = await this.findTriplesTids(patch.oldQuads);
        const delta = await this.txnDelta(txc.id, patch.newQuads,
          deletedTriplesTids.map(tt => tt.asTripleTids()));

        // Include tid changes in final patch
        txc.sw.next('new-tids');
        const { allTidsPatch, tidPatch } =
          await this.txnTidPatches(txc.id, patch.newQuads, deletedTriplesTids);

        // Include journaling in final patch
        txc.sw.next('journal');
        const journal = await this.journal.state(), tail = await journal.tail();
        let { patch: journaling, entry } = await tail.createNext(delta, time);
        journaling = journaling.concat(await journal.setNext(entry, time));
        // Notify the update (will be pushed to immediate)
        this.updateSource.next(update);
        return {
          patch: this.transactionPatch(patch, allTidsPatch, tidPatch, journaling),
          value: new DeltaMessage(time, delta.json)
        };
      }
    });
  }

  private async txnTidPatches(tid: string, insert: Quad[], deletedTriplesTids: TripleTidQuads[]) {
    const allTidsPatch = await this.newTid(tid);
    const tidPatch = (await this.newTriplesTid(insert, tid))
      .concat({ oldQuads: flatten(deletedTriplesTids.map(tripleTids => tripleTids.tids)) });
    return { allTidsPatch, tidPatch };
  }

  private txnDelta(tid: string, insert: Quad[], deletedTriplesTids: TripleTids[]) {
    return this.meldJson.newDelta({
      tid, insert,
      // Delta has reifications of old quads, which we infer from found triple tids
      delete: TripleTids.reify(deletedTriplesTids)
    });
  }

  @SuSetDataset.checkNotClosed.async
  async apply(
    msgData: JsonDelta, msgTime: TreeClock,
    arrivalTime: TreeClock, localTime: TreeClock): Promise<DeltaMessage | null> {
    return this.dataset.transact<DeltaMessage | null>({
      id: msgData.tid,
      prepare: async txc => {
        // Check we haven't seen this transaction before in the journal
        txc.sw.next('find-tids');
        if (!(await this.tidsGraph.find1<AllTids>({ '@id': 'qs:all', tid: [txc.id] }))) {
          this.log.debug(`Applying tid: ${txc.id}`);

          txc.sw.next('unreify');
          const delta = await this.meldJson.asMeldDelta(msgData);
          let patch = new PatchQuads([], delta.insert.map(toDomainQuad));
          let allTidsPatch = await this.newTid(delta.tid);
          // The delta's delete contains reifications of deleted triples
          let tidPatch = await unreify(delta.delete)
            .reduce(async (tripleTidPatch, [triple, theirTids]) => {
              // For each unique deleted triple, subtract the claimed tids from the tids we have
              const ourTripleTids = await this.findTripleTids(tripleId(triple));
              const toRemove = ourTripleTids.filter(tripleTid => theirTids.includes(tripleTid.object.value));
              // If no tids are left, delete the triple in our graph
              if (toRemove.length == ourTripleTids.length)
                patch.oldQuads.push(toDomainQuad(triple));
              return (await tripleTidPatch).concat({ oldQuads: toRemove });
            }, Promise.resolve(new PatchQuads()));

          txc.sw.next('apply-cx'); // "cx" = constraint
          const update = await this.asUpdate(arrivalTime, patch);
          const cxn = await this.applyConstraint({ patch, update, tid: txc.id }, localTime);
          // After applying the constraint, patch new quads might have changed
          tidPatch = tidPatch.concat(await this.newTriplesTid(patch.newQuads, delta.tid));

          // Include journaling in final patch
          txc.sw.next('journal');
          const journal = await this.journal.state(), tail = await journal.tail();
          let { patch: journaling, entry } = await tail.createNext(delta, arrivalTime, msgTime);
          if (cxn != null) {
            // Create a follow-on entry for the constraint "transaction"
            let { patch: cxJournaling, entry: cxEntry } = await entry.createNext(cxn.delta, localTime);
            journaling = journaling.concat(cxJournaling);
            entry = cxEntry; // Skip original entry
          }
          journaling = journaling.concat(await journal.setNext(entry, localTime));

          // Notify the update (will be pushed to immediate)
          this.updateSource.next(update);
          // If the constraint has done anything, we need to merge its work into
          // ours and notify its update too
          if (cxn != null) {
            allTidsPatch = allTidsPatch.concat(cxn.allTidsPatch);
            tidPatch = tidPatch.concat(cxn.tidPatch);
            patch = patch.concat(cxn.patch);
            this.updateSource.next(cxn.update);
          }
          return {
            patch: this.transactionPatch(patch, allTidsPatch, tidPatch, journaling),
            value: cxn != null ? new DeltaMessage(localTime, cxn.delta.json) : null
          };
        } else {
          this.log.debug(`Rejecting tid: ${txc.id} as duplicate`);
          // We don't have to save the new local clock time, nothing's happened
          return { value: null };
        }
      }
    });
  }

  /**
   * Caution: mutates to.patch
   * @param to transaction details to apply the patch to
   * @param localTime local clock time
   */
  async applyConstraint(
    to: { patch: PatchQuads, update: MeldUpdate, tid: string },
    localTime: TreeClock): Promise<ConstraintTxn | null> {
    const result = await this.constraint.apply(to.update, query => this.read(query));
    if (result != null) {
      const tid = uuid();
      const patch = await this.write(result);
      const update = await this.asUpdate(localTime, patch);

      const deletedExistingTidQuads = await this.findTriplesTids(patch.oldQuads);
      // Triples that were inserted in the applied transaction may now be
      // deleted - these need to be removed from the applied transaction
      // patch but still published in the delta
      const deleted = to.patch.removeAll('newQuads', patch.oldQuads);
      const deletedTriplesTids = deletedExistingTidQuads.map(tt => tt.asTripleTids())
        .concat(deleted.map(delQuad => new TripleTids(delQuad, [to.tid])));
      const delta = await this.txnDelta(tid, patch.newQuads, deletedTriplesTids);

      const { allTidsPatch, tidPatch } =
        await this.txnTidPatches(tid, patch.newQuads, deletedExistingTidQuads);
      return { delta, update, patch, allTidsPatch, tidPatch };
    }
    return null;
  }

  /**
   * Rolls up the given transaction details into a single patch. This method is
   * just a type convenience for ensuring everything needed for a transaction is
   * present.
   * @param time the local time of the transaction
   * @param dataPatch the transaction data patch
   * @param allTidsPatch insertion to qs:all TIDs in TID graph
   * @param tripleTidPatch triple TID patch (inserts and deletes)
   * @param journaling transaction journaling patch
   */
  private transactionPatch(
    dataPatch: PatchQuads,
    allTidsPatch: PatchQuads,
    tripleTidPatch: PatchQuads,
    journaling: PatchQuads): PatchQuads {
    return dataPatch.concat(allTidsPatch).concat(tripleTidPatch).concat(journaling);
  }

  private async asUpdate(time: TreeClock, patch: PatchQuads): Promise<MeldUpdate> {
    return {
      '@ticks': time.ticks,
      '@delete': await this.toSubjects(patch.oldQuads),
      '@insert': await this.toSubjects(patch.newQuads)
    };
  }

  /**
   * @returns flattened subjects compacted with no context
   * @see https://www.w3.org/TR/json-ld11/#flattened-document-form
   */
  private async toSubjects(quads: Quad[]): Promise<Subject[]> {
    // The flatten function is guaranteed to create a graph object
    const graph: any = await flatJsonLd(await rdfToJson(quads), {});
    return graph['@graph'];
  }

  private newTid(tid: UUID | UUID[]): Promise<PatchQuads> {
    return this.tidsGraph.insert(<AllTids>{ '@id': 'qs:all', tid });
  }

  private newTriplesTid(triples: Triple[], tid: UUID): Promise<PatchQuads> {
    return this.tidsGraph.insert(triples.map<HashTid>(
      triple => ({ '@id': tripleId(triple), tid })));
  }

  private newTripleTids(triple: Triple, tids: UUID[]): Promise<PatchQuads> {
    const theTripleId = tripleId(triple);
    return this.tidsGraph.insert(tids.map<HashTid>(
      tid => ({ '@id': theTripleId, tid })));
  }

  private async findTriplesTids(quads: Triple[]): Promise<TripleTidQuads[]> {
    return from(quads).pipe(
      flatMap(async quad =>
        new TripleTidQuads(quad, await this.findTripleTids(tripleId(quad)))),
      toArray()).toPromise();
  }

  private findTripleTids(tripleId: string): Promise<Quad[]> {
    return this.tidsGraph.findQuads({ '@id': tripleId } as Partial<HashTid>);
  }

  /**
   * Applies a snapshot to this dataset.
   * Caution: uses multiple transactions, so the world must be held up by the caller.
   * @param snapshot snapshot with batches of quads and tids
   * @param localTime the time of the local process, to be saved
   */
  @SuSetDataset.checkNotClosed.async
  async applySnapshot(snapshot: DatasetSnapshot, localTime: TreeClock) {
    // First reset the dataset with the given parameters.
    // Note that this is not awaited because the tids and quads are hot, so we
    // must subscribe to them on the current tick. The transaction lock will
    // take care of making sure the reset happens first.
    const dataReset = this.dataset.transact({
      id: 'suset-reset',
      prepare: async () =>
        ({ patch: await this.journal.reset(snapshot.lastHash, snapshot.lastTime, localTime) })
    });

    const tidsApplied = snapshot.tids.pipe(flatMap(
      // Each batch of TIDs goes in happily as an array
      tids => this.dataset.transact({
        id: 'snapshot-tids-batch',
        prepare: async () => ({ patch: await this.newTid(tids) })
      }))).toPromise();

    const quadsApplied = snapshot.quads.pipe(
      // For each batch of reified quads with TIDs, first unreify
      flatMap(async batch => this.dataset.transact({
        id: 'snapshot-batch',
        prepare: async () => ({
          patch: await from(unreify(batch)).pipe(
            // For each triple in the batch, insert the TIDs into the tids graph
            flatMap(async ([triple, tids]) => (await this.newTripleTids(triple, tids))
              // And include the triple itself
              .concat({ newQuads: [toDomainQuad(triple)] })),
            // Concat all of the resultant batch patches together
            reduce((batchPatch, entryPatch) => batchPatch.concat(entryPatch)))
            .toPromise()
        })
      }))).toPromise();
    return Promise.all([dataReset, quadsApplied, tidsApplied]);
  }

  /**
   * Takes a snapshot of data, including transaction IDs.
   * This requires a consistent view, so a transaction lock is taken until all data has been emitted.
   * To avoid holding up the world, buffer the data.
   */
  @SuSetDataset.checkNotClosed.async
  async takeSnapshot(): Promise<DatasetSnapshot> {
    return new Promise((resolve, reject) => {
      this.dataset.transact({
        id: 'snapshot',
        prepare: async () => {
          const dataEmitted = new Future;
          const journal = await this.journal.state();
          const tail = await journal.tail();
          resolve({
            lastTime: tail.time,
            lastHash: tail.hash,
            quads: this.graph.match().pipe(
              bufferCount(10), // TODO batch size config
              flatMap(async batch => TripleTids.reify(
                (await this.findTriplesTids(batch)).map(tt => tt.asTripleTids()))),
              tapComplete(dataEmitted)),
            tids: this.tidsGraph.graph.match(qsName('all'), qsName('#tid')).pipe(
              map(tid => tid.object.value), bufferCount(10)) // TODO batch size config
          });
          await dataEmitted; // If this rejects, data will error
          return {}; // No patch to apply
        }
      }).catch(reject);
    });
  }
}

function tripleId(triple: Triple): string {
  return toPrefixedId('thash', hashTriple(triple).encode());
}
